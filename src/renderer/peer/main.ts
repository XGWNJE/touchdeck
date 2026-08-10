// P2P 中继（隐藏窗口）：Windows 端 = 房间 host。
// 连接信令 → 建/回房间（控制台显示房间码）→ 等 client（安卓）加入 →
// client 创建 DataChannel → 收到版本化动作消息 → IPC 主进程执行 → 定向 ACK 回原 client。
import { actionResult, parseActionRequest, type ActionResult } from "../../shared/action-protocol";
// 打洞失败（对称 NAT）由 TURN 兜底；所有信令/媒体经 DTLS 加密。
//
// 健壮性（2026-08-05）：
// - 房号持久化（localStorage）+ 信令重连带原房号 reclaim：信令闪断不再全量重配。
// - 重连指数退避（2s→30s 封顶），10 次失败进 signal-failed 终态（不再无限重试）。
// - 信令断开期间 peers 保留（服务端宽限期不删房）；死连接由 DataChannel 心跳判半开清理。
// - channel.onclose / ICE failed 清理 peer 并实时刷新设备计数（按 open 通道数，不再虚高）。
const SIGNAL_DEFAULT = "wss://api.xgwnje.cn/signal";
const ROOM_KEY = "touchdeck.roomCode";
const HOST_KEY = "touchdeck.hostKey";
const PAIR_KEY = "touchdeck.pairKey";
const PAIR_EXPIRES_KEY = "touchdeck.pairExpiresAt";
const MAX_ATTEMPTS = 10;
const PING_TIMEOUT_MS = 25000; // client 每 5s ping，25s 无消息判半开

interface TurnCfg { urls?: string[]; url?: string; username?: string; credential?: string; }
interface Peer { pc: RTCPeerConnection; channel: RTCDataChannel | null; lastPing: number; }

let ws: WebSocket | null = null;
let roomCode: string | null = null;
let turnCfg: TurnCfg | null = null;
let stopped = true;
let attempts = 0;
let pairExpiryTimer: ReturnType<typeof setTimeout> | null = null;
let pairRequestTimer: ReturnType<typeof setTimeout> | null = null;
let pairRequestPending = false;
let revokeRequestTimer: ReturnType<typeof setTimeout> | null = null;
let revokeRequestPending = false;
// 主动 close（onPeerStart 换连接）会触发 onclose，识别并吞掉防误排重连
let intentionalClose = false;
// 多客户端：clientId -> { pc, channel, lastPing }（每台手机一条独立 WebRTC 连接）
const peers = new Map<string, Peer>();

function localSecret(key: string): string {
  let value = localStorage.getItem(key);
  if (!value) {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    value = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    localStorage.setItem(key, value);
  }
  return value;
}

function postStatus(payload: Record<string, unknown>): void {
  window.touchdeck.peerStatus(payload);
}

function rememberPairKey(value: string, ttlMs: unknown): void {
  localStorage.setItem(PAIR_KEY, value);
  if (pairExpiryTimer) clearTimeout(pairExpiryTimer);
  // 不用服务端绝对时间计时：Host 与 VPS 的时钟偏差不能延长一次性密钥的保留期。
  const delay = typeof ttlMs === "number" ? Math.max(0, Math.min(ttlMs, 5 * 60 * 1000)) : 0;
  localStorage.setItem(PAIR_EXPIRES_KEY, String(Date.now() + delay));
  pairExpiryTimer = setTimeout(() => {
    // 只清理仍是这一轮房间的值，避免旧计时器删掉后续重建出来的新密钥。
    if (localStorage.getItem(PAIR_KEY) === value) {
      localStorage.removeItem(PAIR_KEY);
      localStorage.removeItem(PAIR_EXPIRES_KEY);
      postStatus({ pairingKey: null });
    }
  }, delay);
}

function clearPairKey(): void {
  localStorage.removeItem(PAIR_KEY);
  localStorage.removeItem(PAIR_EXPIRES_KEY);
  if (pairExpiryTimer) clearTimeout(pairExpiryTimer);
  pairExpiryTimer = null;
}

function restorePairKey(active: unknown, ttlMs: unknown): string | null {
  const saved = localStorage.getItem(PAIR_KEY);
  const localExpires = Number(localStorage.getItem(PAIR_EXPIRES_KEY) || 0);
  const serverRemaining = typeof ttlMs === "number" ? Math.max(0, ttlMs) : 0;
  const remaining = Math.min(Math.max(0, localExpires - Date.now()), serverRemaining);
  if (active !== true || !saved || remaining <= 0) {
    clearPairKey();
    return null;
  }
  rememberPairKey(saved, remaining);
  return saved;
}

function cancelPairKeyRequest(): void {
  pairRequestPending = false;
  if (pairRequestTimer) clearTimeout(pairRequestTimer);
  pairRequestTimer = null;
}

function finishPairKeyRequest(error?: string): void {
  cancelPairKeyRequest();
  postStatus({ pairingPending: false, pairingError: error || null });
}

function cancelRevokeRequest(): void {
  revokeRequestPending = false;
  if (revokeRequestTimer) clearTimeout(revokeRequestTimer);
  revokeRequestTimer = null;
}

function finishRevokeRequest(error?: string): void {
  cancelRevokeRequest();
  postStatus({ revokingDevices: false, revokeError: error || null });
}

// 设备计数按「通道实际 open」的设备数（旧版按 Map 条目，死连接虚高）
function openChannels(): number {
  let n = 0;
  for (const p of peers.values()) {
    if (p.channel && p.channel.readyState === "open") n++;
  }
  return n;
}

// 有活设备报 connected，无活设备回 room（等待加入），计数实时跟随
function postPeers(): void {
  const n = openChannels();
  if (n > 0) postStatus({ phase: "connected", peers: n });
  else if (roomCode) postStatus({ phase: "room", code: roomCode, peers: 0 });
}

function backoffMs(n: number): number {
  return Math.min(2000 * Math.pow(2, n - 1), 30000);
}

async function connectSignal(url: string): Promise<void> {
  ws = new WebSocket(url);
  ws.onopen = () => {
    postStatus({ phase: "signal-ok" });
    // reclaim：带记忆的房号重连（服务端宽限期内复用房间，旧设备自动恢复）
    const saved = localStorage.getItem(ROOM_KEY);
    ws!.send(JSON.stringify({ type: "create-room", code: saved || undefined, hostKey: localSecret(HOST_KEY) }));
  };
  ws.onmessage = (e) => handleSignal(JSON.parse(e.data));
  ws.onclose = () => {
    if (intentionalClose) { intentionalClose = false; return; }
    if (stopped) return;
    if (pairRequestPending) finishPairKeyRequest("signal-unavailable");
    if (revokeRequestPending) finishRevokeRequest("signal-unavailable");
    attempts++;
    if (attempts > MAX_ATTEMPTS) {
      stopped = true;
      postStatus({ phase: "signal-failed", error: `重连 ${MAX_ATTEMPTS} 次未成功` });
      return;
    }
    // peers 不拆：服务端宽限期保留房间，WebRTC 连接可能还活着；
    // 半开的死连接由心跳超时各自清理
    postStatus({ phase: "reconnecting", attempt: attempts });
    setTimeout(() => { if (!stopped) connectSignal(url); }, backoffMs(attempts));
  };
  ws.onerror = () => { try { ws!.close(); } catch { /* 交给 onclose 重连 */ } };
}

function handleSignal(msg: any): void {
  if (msg.type === "room") {
    roomCode = msg.code;
    turnCfg = msg.turn;
    const pairingKey = typeof msg.pairKey === "string"
      ? (rememberPairKey(msg.pairKey, msg.pairTtlMs), msg.pairKey)
      : restorePairKey(msg.pairKeyActive, msg.pairTtlMs);
    attempts = 0; // 房间到手才算真正连上，重置退避
    localStorage.setItem(ROOM_KEY, roomCode!);
    postStatus({ phase: "room", code: roomCode, pairingKey, hostFingerprint: msg.hostFingerprint,
      peers: openChannels(), devicesRevoked: false, revokeError: null });
    return;
  }
  if (msg.type === "pair-key") {
    if (typeof msg.pairKey !== "string") {
      finishPairKeyRequest("invalid-response");
      return;
    }
    rememberPairKey(msg.pairKey, msg.pairTtlMs);
    finishPairKeyRequest();
    postStatus({ pairingKey: msg.pairKey });
    return;
  }
  if (msg.type === "error" && pairRequestPending) {
    finishPairKeyRequest(typeof msg.reason === "string" ? msg.reason : "request-failed");
    return;
  }
  if (msg.type === "error" && revokeRequestPending) {
    finishRevokeRequest(typeof msg.reason === "string" ? msg.reason : "request-failed");
    return;
  }
  if (msg.type === "devices-revoked") {
    clearPairKey();
    finishRevokeRequest();
    postStatus({ devicesRevoked: true, pairingKey: null, peers: openChannels() });
    return;
  }
  if (msg.type === "room-expired") {
    // 房间 TTL 到期（服务端主动通知）：清理并提示，不显示僵尸房号
    teardownAll();
    roomCode = null;
    localStorage.removeItem(ROOM_KEY);
    clearPairKey();
    if (pairRequestPending) finishPairKeyRequest("room-expired");
    if (revokeRequestPending) finishRevokeRequest("room-expired");
    stopped = true;
    postStatus({ phase: "room-expired", code: null, peers: 0 });
    return;
  }
  if (msg.type === "peer") {
    // 新客户端加入（或 reclaim 后服务端补通告）：host 侧为它创建独立连接并等 offer
    // 只在服务端明确标记 paired 时清掉已消费的一次性密钥；已登记设备用 deviceKey
    // 续连时 paired=false，不能误删正在等待另一台新设备使用的密钥。
    if (msg.paired === true) {
      clearPairKey();
    }
    postStatus({ phase: "peer-joined", ...(msg.paired === true ? { pairingKey: null } : {}) });
    setupPeer(msg.clientId);
    return;
  }
  if (msg.type === "signal") {
    const clientId = msg.from;
    if (!clientId) return;
    if (!peers.has(clientId)) setupPeer(clientId);
    handlePeerSignal(clientId, msg.data);
    return;
  }
  if (msg.type === "peer-left") {
    if (msg.clientId) teardownPeer(msg.clientId);
    else teardownAll();
    postPeers();
    return;
  }
}

function iceServers(): RTCIceServer[] {
  const list: RTCIceServer[] = [
    { urls: "stun:212.135.41.88:3478" },
  ];
  if (turnCfg) {
    list.push({ urls: turnCfg.urls || [turnCfg.url!], username: turnCfg.username, credential: turnCfg.credential });
  }
  return list;
}

function setupPeer(clientId: string): void {
  if (peers.has(clientId)) return;
  const pc = new RTCPeerConnection({ iceServers: iceServers() });
  peers.set(clientId, { pc, channel: null, lastPing: Date.now() });
  pc.onicecandidate = (e) => {
    if (e.candidate) ws!.send(JSON.stringify({ type: "signal", to: clientId, data: { ice: e.candidate } }));
  };
  pc.onconnectionstatechange = () => {
    // 有活设备时保持聚合显示（单台 ICE 抖动不把「已直连（N 台）」打回「建立中」）
    const n = openChannels();
    if (n > 0) postStatus({ phase: "connected", peers: n });
    else postStatus({ phase: "peer-state", state: pc.connectionState, peers: 0 });
    if (pc.connectionState === "failed") {
      // ICE 失败不可恢复：拆掉等 client 重 join 建新连接（restartIce 留给 client 侧）
      console.log("peer ICE failed, teardown:", clientId);
      teardownPeer(clientId);
      postPeers();
    } else if (pc.connectionState === "closed") {
      teardownPeer(clientId);
      postPeers();
    }
  };
  pc.ondatachannel = (e) => {
    const p = peers.get(clientId);
    if (!p) return;
    p.channel = e.channel;
    bindChannel(clientId, p);
  };
}

function bindChannel(clientId: string, p: Peer): void {
  p.channel!.onopen = () => {
    p.lastPing = Date.now();
    postPeers();
    // 通道就绪：请主进程把当前有效按钮集推下来（安卓动态渲染；离线 panel.json 仅兜底）
    window.touchdeck.peerChannelOpen();
  };
  p.channel!.onclose = () => {
    // 设备断开必须清理 + 刷新计数（旧版只改文案不删 Map，计数永久虚高）
    console.log("peer channel closed:", clientId);
    teardownPeer(clientId);
    postPeers();
  };
  p.channel!.onmessage = (e) => {
    p.lastPing = Date.now(); // 任何消息都是存活证据
    try {
      const msg = JSON.parse(e.data);
      if (msg && msg.ping) {
        // DataChannel 应用层心跳：client 每 5s ping，回 pong 供对端判半开
        p.channel!.send(JSON.stringify({ pong: msg.ping }));
        return;
      }
      const request = parseActionRequest(msg);
      if (request) {
        window.touchdeck.peerAction(clientId, request);
      } else if (msg && msg.type === "action") {
        // 格式错误也要明确回执，避免 Android 一直等到超时。
        const requestId = typeof msg.requestId === "string" ? msg.requestId : "";
        if (requestId) sendActionResult(clientId, actionResult(requestId, "failed", "invalid-message"));
      }
    } catch { /* 非 JSON 忽略 */ }
  };
}

function sendActionResult(clientId: string, result: ActionResult): void {
  const peer = peers.get(clientId);
  if (!peer || !peer.channel || peer.channel.readyState !== "open") return;
  try { peer.channel.send(JSON.stringify(result)); } catch { /* 对端已断开，由其超时处理 */ }
}

// 半开通道巡检：通道还 open 但 25s 无任何消息（WiFi 切网僵死等），拆掉等重连
setInterval(() => {
  const now = Date.now();
  for (const [clientId, p] of Array.from(peers.entries())) {
    if (p.channel && p.channel.readyState === "open" && now - p.lastPing > PING_TIMEOUT_MS) {
      console.log("peer heartbeat timeout:", clientId);
      teardownPeer(clientId);
      postPeers();
    }
  }
}, 10000);

function handlePeerSignal(clientId: string, data: any): void {
  const p = peers.get(clientId);
  if (!p || !p.pc) return;
  if (data.sdp && data.sdp.type === "offer") {
    p.pc.setRemoteDescription(data.sdp).then(async () => {
      const answer = await p.pc.createAnswer();
      await p.pc.setLocalDescription(answer);
      ws!.send(JSON.stringify({ type: "signal", to: clientId, data: { sdp: p.pc.localDescription } }));
    }).catch((err) => postStatus({ phase: "peer-error", error: String(err) }));
  } else if (data.ice) {
    p.pc.addIceCandidate(data.ice).catch((err) => postStatus({ phase: "peer-error", error: String(err) }));
  }
}

function teardownPeer(clientId: string): void {
  const p = peers.get(clientId);
  if (!p) return;
  try { if (p.channel) p.channel.close(); } catch { /* 忽略 */ }
  try { if (p.pc) p.pc.close(); } catch { /* 忽略 */ }
  peers.delete(clientId);
}

function teardownAll(): void {
  for (const clientId of Array.from(peers.keys())) teardownPeer(clientId);
}

window.touchdeck.onPeerStart((signalUrl) => {
  const url = (signalUrl && signalUrl.trim()) || SIGNAL_DEFAULT;
  cancelPairKeyRequest();
  cancelRevokeRequest();
  stopped = false;
  attempts = 0;
  if (ws && ws.readyState <= 1) { intentionalClose = true; ws.close(); }
  teardownAll();
  connectSignal(url);
});

window.touchdeck.onPeerStop(() => {
  stopped = true;
  cancelPairKeyRequest();
  cancelRevokeRequest();
  try {
    // 人为停止：显式删房（不走 host 宽限期），设备端立即收到 peer-left
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: "close-room" }));
    if (ws) ws.close();
  } catch { /* 忽略 */ }
  teardownAll();
  roomCode = null;
  // 只结束当前会话，保留 Host 绑定的房号；下次开启时恢复同一持久登记。
  // 取消设备授权必须走单独的 revoke-devices，不能把普通“关闭连接”当成撤销。
  clearPairKey();
  postStatus({ phase: "idle", code: null, peers: 0 });
});

window.touchdeck.onPeerCreatePairKey(() => {
  if (pairRequestPending) return;
  if (!roomCode || !ws || ws.readyState !== WebSocket.OPEN) {
    postStatus({ pairingPending: false, pairingError: "signal-unavailable" });
    return;
  }
  pairRequestPending = true;
  postStatus({ pairingPending: true, pairingError: null });
  try {
    ws.send(JSON.stringify({ type: "create-pair-key" }));
    pairRequestTimer = setTimeout(() => finishPairKeyRequest("timeout"), 10000);
  } catch {
    finishPairKeyRequest("signal-unavailable");
  }
});

window.touchdeck.onPeerRevokeDevices(() => {
  if (revokeRequestPending) return;
  if (!roomCode || !ws || ws.readyState !== WebSocket.OPEN) {
    postStatus({ revokingDevices: false, revokeError: "signal-unavailable" });
    return;
  }
  revokeRequestPending = true;
  postStatus({ revokingDevices: true, revokeError: null, devicesRevoked: false });
  try {
    ws.send(JSON.stringify({ type: "revoke-devices" }));
    revokeRequestTimer = setTimeout(() => finishRevokeRequest("timeout"), 10000);
  } catch {
    finishRevokeRequest("signal-unavailable");
  }
});

// 主进程广播（按钮集/场景更新）：转发给所有 open 通道；未 open 的设备上线时
// 由 peerChannelOpen 触发补推，不在这里缓存
window.touchdeck.onPeerBroadcast((payload) => {
  const data = JSON.stringify(payload);
  for (const p of peers.values()) {
    if (p.channel && p.channel.readyState === "open") {
      try { p.channel.send(data); } catch { /* 单设备失败不阻塞其他设备 */ }
    }
  }
});

// 主进程只把 ACK 路由到发起动作的 clientId，禁止向所有设备广播执行结果。
window.touchdeck.onPeerActionResult((payload) => {
  if (!payload || typeof payload.clientId !== "string" || !payload.result) return;
  sendActionResult(payload.clientId, payload.result as ActionResult);
});

// 监听器全部挂好后再通知主进程发送冷启动指令。
window.touchdeck.peerReady();

// 调试句柄（原型期）：模块作用域不污染 window，CDP 排障走这里读链路状态
(window as any).__peerDebug = {
  peers,
  status: () => ({ roomCode, attempts, stopped, ws: ws ? ws.readyState : null, openChannels: openChannels() }),
};
