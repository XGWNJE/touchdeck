// TouchDeck P2P 信令服务：WebSocket 房间配对 + SDP/ICE 中继 + TURN 凭据下发
// 支持 1 host + N client（多悬浮球同时连接）：client 有独立 clientId，signal 按 from/to 路由
// 部署�?opt/touchdeck-signal/，systemd 服务 touchdeck-signal，nginx 反代 /signal
import { WebSocketServer } from "ws";
import fs from "fs";

const PORT = 8790;
const ROOM_TTL_MS = 30 * 60 * 1000;
const MAX_CLIENTS = 8;
const TURN_CRED_FILE = "/etc/touchdeck-signal/turn-credentials"; // username:password
const TURN_HOST = "212.135.41.88";

function turnCredentials() {
  try {
    const [user, pass] = fs.readFileSync(TURN_CRED_FILE, "utf8").trim().split(":");
    return {
      urls: [
        `turn:${TURN_HOST}:3478?transport=udp`,
        `turn:${TURN_HOST}:3478?transport=tcp`,
      ],
      username: user,
      credential: pass,
    };
  } catch {
    return null;
  }
}

const rooms = new Map(); // code -> { host, clients: Map<clientId, ws>, expires }

function newCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function newClientId() {
  return Math.random().toString(36).slice(2, 10);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function closeRoom(code) {
  const r = rooms.get(code);
  if (r) {
    send(r.host, { type: "peer-left" });
    for (const ws of r.clients.values()) send(ws, { type: "peer-left" });
    rooms.delete(code);
  }
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

wss.on("connection", (ws) => {
  let roomCode = null;
  let role = null; // host | client
  let clientId = null; // 仅 client

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: "error", reason: "bad-json" }); }

    if (msg.type === "create-room") {
      for (const [code, r] of rooms) {
        if (Date.now() > r.expires) closeRoom(code);
      }
      let code = newCode();
      while (rooms.has(code)) code = newCode();
      rooms.set(code, { host: ws, clients: new Map(), expires: Date.now() + ROOM_TTL_MS });
      roomCode = code; role = "host";
      send(ws, { type: "room", code, role, turn: turnCredentials() });
      return;
    }

    if (msg.type === "join-room") {
      const r = rooms.get(String(msg.code));
      if (!r) return send(ws, { type: "error", reason: "room-not-found" });
      if (Date.now() > r.expires) { closeRoom(msg.code); return send(ws, { type: "error", reason: "room-expired" }); }
      if (r.clients.size >= MAX_CLIENTS) return send(ws, { type: "error", reason: "room-full" });
      clientId = newClientId();
      r.clients.set(clientId, ws);
      roomCode = String(msg.code); role = "client";
      send(ws, { type: "room", code: roomCode, role, clientId, turn: turnCredentials() });
      send(r.host, { type: "peer", peer: "client", clientId });
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

  ws.on("close", () => {
    if (roomCode) {
      const r = rooms.get(roomCode);
      if (!r) return;
      if (role === "host") {
        for (const w of r.clients.values()) send(w, { type: "peer-left" });
        rooms.delete(roomCode);
      } else {
        r.clients.delete(clientId);
        send(r.host, { type: "peer-left", clientId });
      }
    }
  });
});