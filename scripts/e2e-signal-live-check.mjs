// 已部署信令服务的最小黑盒检查；仅使用本进程随机测试凭据，绝不输出其内容。
import assert from "node:assert/strict";
import crypto from "node:crypto";

const url = "wss://api.xgwnje.cn/signal";
const secret = () => crypto.randomBytes(24).toString("base64url");

async function request(message) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
  ws.send(JSON.stringify(message));
  const reply = await new Promise((resolve, reject) => { ws.onmessage = (event) => resolve(JSON.parse(event.data)); ws.onerror = reject; });
  return { ws, reply };
}

const hostKey = secret();
const host = await request({ type: "create-room", hostKey });
assert.equal(host.reply.type, "room");
assert.match(host.reply.code, /^\d{6}$/);
host.ws.close();
await new Promise((resolve) => { host.ws.onclose = resolve; });

const imposter = await request({ type: "create-room", code: host.reply.code, hostKey: secret() });
assert.deepEqual(imposter.reply, { type: "error", reason: "host-auth-failed" });
imposter.ws.close();

const reclaim = await request({ type: "create-room", code: host.reply.code, hostKey });
assert.equal(reclaim.reply.type, "room");
reclaim.ws.send(JSON.stringify({ type: "close-room" }));
reclaim.ws.close();
console.log("live-host-auth-reclaim-guard-ok");
