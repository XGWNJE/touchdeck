// TouchDeck P2P 信令服务：WebSocket 房间配对 + SDP/ICE 中继 + TURN 凭据下发
// 支持 1 host + N client（多悬浮球同时连接）：client 有独立 clientId，signal 按 from/to 路由
// 部署于 /opt/touchdeck-signal/，systemd 服务 touchdeck-signal，nginx 反代 /signal
//
// 健壮性（2026-08-05）：
// - 房间 reclaim：host 断线不立即删房，进入宽限期（HOST_GRACE_MS）等待 host 带原房号
//   create-room  reclaim；期间 client 收 host-gone 保持 WebRTC 不动，host 回来后收 host-back。
//   宽限期满仍无 host 才删房（client 收 peer-left）。解决「host 信令闪断 = 全量手动重配」。
// - 房间 TTL 到期主动通知（定时清扫 + room-expired），不再只有 join/create 时惰性清扫，
//   消除「房间已死、控制台显示僵尸房号」。
// - host 主动 close-room 立即删房（人为停止不走宽限期）。
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = Number(process.env.PORT || 8790);
const ROOM_TTL_MS = 30 * 60 * 1000;
const HOST_GRACE_MS = 90 * 1000;
const MAX_CLIENTS = 8;
const PAIR_TTL_MS = 5 * 60 * 1000;
const JOIN_ATTEMPT_WINDOW_MS = 60 * 1000;
const MAX_JOIN_ATTEMPTS = 5;
const TURN_HOST = "212.135.41.88";
const TURN_SHARED_SECRET = process.env.TOUCHDECK_TURN_SHARED_SECRET || "";

const attemptsByIp = new Map();
function newSecret() { return crypto.randomBytes(24).toString("base64url"); }
function secretHash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function fingerprint(value) { return secretHash(value).slice(0, 16).toUpperCase(); }
function validSecret(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{24,}$/.test(value); }
function allowJoin(ip) {
  const now = Date.now();
  const history = (attemptsByIp.get(ip) || []).filter((at) => now - at < JOIN_ATTEMPT_WINDOW_MS);
  if (history.length >= MAX_JOIN_ATTEMPTS) return false;
  history.push(now); attemptsByIp.set(ip, history); return true;
}

function turnCredentials() {
  if (!TURN_SHARED_SECRET) return null;
  const username = `${Math.floor(Date.now() / 1000) + 10 * 60}:${crypto.randomBytes(6).toString("hex")}`;
  return { urls: [`turn:${TURN_HOST}:3478?transport=udp`, `turn:${TURN_HOST}:3478?transport=tcp`], username,
    credential: crypto.createHmac("sha1", TURN_SHARED_SECRET).update(username).digest("base64") };
}

const rooms = new Map(); // code -> { host, clients: Map<clientId, ws>, expires, graceTimer }

function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function newClientId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// 删房并通知：host 收 reason（过期=room-expired，其余=peer-left），client 一律 peer-left
function closeRoom(code, reason = "closed") {
  const r = rooms.get(code);
  if (!r) return;
  if (r.graceTimer) clearTimeout(r.graceTimer);
  if (r.host) send(r.host, { type: reason === "expired" ? "room-expired" : "peer-left" });
  for (const ws of r.clients.values()) send(ws, { type: "peer-left" });
  rooms.delete(code);
  console.log(`[signal] room ${code} closed (${reason})`);
}

// host 断线：不删房，进入宽限期；client 保持 WebRTC 等待 host 回来
function enterHostGrace(code) {
  const r = rooms.get(code);
  if (!r) return;
  r.host = null;
  for (const ws of r.clients.values()) send(ws, { type: "host-gone" });
  r.graceTimer = setTimeout(() => closeRoom(code, "host-grace-timeout"), HOST_GRACE_MS);
  console.log(`[signal] room ${code} host gone, grace ${HOST_GRACE_MS / 1000}s (${r.clients.size} clients waiting)`);
}

const wss = new WebSocketServer({ port: PORT });
console.log(`[signal] listening :${PORT}`);

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
});
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);
wss.on("close", () => clearInterval(heartbeat));

// 房间 TTL 定时清扫：到期主动通知 host（room-expired）与 client（peer-left）
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now > r.expires) closeRoom(code, "expired");
  }
}, 60000);
wss.on("close", () => clearInterval(sweeper));

wss.on("connection", (ws, req) => {
  let roomCode = null;
  let role = null; // host | client
  let clientId = null; // 仅 client
  const remoteIp = req.socket.remoteAddress || "unknown";

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: "error", reason: "bad-json" }); }

    if (msg.type === "create-room") {
      if (!validSecret(msg.hostKey)) return send(ws, { type: "error", reason: "host-auth-required" });
      const hostKeyHash = secretHash(msg.hostKey);
      let code = null;
      // reclaim：host 带原房号重连。宽限期内（host 不在）直接复用；房号被活房占用则换新号
      const want = typeof msg.code === "string" && /^\d{6}$/.test(msg.code) ? msg.code : null;
      if (want) {
        const r = rooms.get(want);
        if (r && !r.host && Date.now() <= r.expires && r.hostKeyHash === hostKeyHash) {
          if (r.graceTimer) { clearTimeout(r.graceTimer); r.graceTimer = null; }
          r.host = ws;
          r.expires = Date.now() + ROOM_TTL_MS; // 续期：reclaim 视为活跃
          roomCode = want; role = "host";
          send(ws, { type: "room", code: want, role, hostFingerprint: r.hostFingerprint, turn: turnCredentials() });
          for (const cws of r.clients.values()) send(cws, { type: "host-back" });
          // 把存活的 client 重新通告给 host（host 侧按 clientId 去重）
          for (const cid of r.clients.keys()) send(ws, { type: "peer", peer: "client", clientId: cid });
          console.log(`[signal] room ${want} reclaimed (${r.clients.size} clients restored)`);
          return;
        }
        if (r && !r.host && Date.now() <= r.expires && r.hostKeyHash !== hostKeyHash) {
          return send(ws, { type: "error", reason: "host-auth-failed" });
        }
        if (!r) code = want; // 房号空闲：沿用（旧客户端记忆房号可重 join）
      }
      if (!code) {
        code = newCode();
        while (rooms.has(code)) code = newCode();
      }
      const pairKey = newSecret();
      rooms.set(code, { host: ws, clients: new Map(), devices: new Map(), hostKeyHash, hostFingerprint: fingerprint(msg.hostKey),
        pairKeyHash: secretHash(pairKey), pairExpires: Date.now() + PAIR_TTL_MS, expires: Date.now() + ROOM_TTL_MS, graceTimer: null });
      roomCode = code; role = "host";
      send(ws, { type: "room", code, role, pairKey, pairTtlMs: PAIR_TTL_MS, hostFingerprint: fingerprint(msg.hostKey), turn: turnCredentials() });
      return;
    }

    if (msg.type === "close-room" && roomCode && role === "host") {
      closeRoom(roomCode, "host-closed");
      return;
    }

    if (msg.type === "join-room") {
      if (!allowJoin(remoteIp)) return send(ws, { type: "error", reason: "too-many-attempts" });
      const r = rooms.get(String(msg.code));
      if (!r) return send(ws, { type: "error", reason: "room-not-found" });
      if (Date.now() > r.expires) { closeRoom(String(msg.code), "expired"); return send(ws, { type: "error", reason: "room-expired" }); }
      if (r.clients.size >= MAX_CLIENTS) return send(ws, { type: "error", reason: "room-full" });
      let deviceKey = null;
      if (validSecret(msg.deviceKey) && r.devices.has(secretHash(msg.deviceKey))) {
        deviceKey = msg.deviceKey;
      } else if (validSecret(msg.pairKey) && r.pairKeyHash && Date.now() <= r.pairExpires && crypto.timingSafeEqual(Buffer.from(secretHash(msg.pairKey)), Buffer.from(r.pairKeyHash))) {
        deviceKey = newSecret();
        r.devices.set(secretHash(deviceKey), true);
        r.pairKeyHash = null; // 配对密钥只可使用一次；后续只接受该设备续连凭据
      } else return send(ws, { type: "error", reason: "pairing-required" });
      clientId = newClientId();
      r.clients.set(clientId, ws);
      roomCode = String(msg.code); role = "client";
      send(ws, { type: "room", code: roomCode, role, clientId, deviceKey, hostFingerprint: r.hostFingerprint, turn: turnCredentials() });
      console.log(`[signal] room ${roomCode} client ${clientId} joined (${r.clients.size}/${MAX_CLIENTS})`);
      // host 在宽限期（不在线）时不通告，reclaim 时会统一补通告
      if (r.host) send(r.host, { type: "peer", peer: "client", clientId });
      return;
    }

    if (msg.type === "signal" && roomCode) {
      const r = rooms.get(roomCode);
      if (!r) return;
      if (role === "host") {
        const target = r.clients.get(String(msg.to));
        send(target, { type: "signal", to: clientId, data: msg.data });
      } else {
        send(r.host, { type: "signal", from: clientId, data: msg.data });
      }
      return;
    }

    send(ws, { type: "error", reason: "unknown" });
  });

  ws.on("close", (code, reason) => {
    if (roomCode) {
      const r = rooms.get(roomCode);
      if (!r) return;
      if (role === "host") {
        // 不立即删房：宽限期等待 reclaim（host 信令闪断不再全量重配）
        enterHostGrace(roomCode);
      } else {
        console.log(`[signal] room ${roomCode} client ${clientId} ws closed (${code} ${reason || ""})`);
        r.clients.delete(clientId);
        if (r.host) send(r.host, { type: "peer-left", clientId });
      }
    } else {
      console.log(`[signal] anonymous ws closed (${code})`);
    }
  });
});
