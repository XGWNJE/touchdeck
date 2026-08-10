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

function waitForType(ws, type) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type !== type && message.type !== "error") return;
      ws.removeEventListener("message", onMessage);
      resolve(message);
    };
    ws.addEventListener("message", onMessage);
    ws.onerror = reject;
  });
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

const first = await request({ type: "join-room", code: host.reply.code, pairKey: host.reply.pairKey });
assert.equal(first.reply.type, "room");
assert.match(first.reply.deviceKey, /^[A-Za-z0-9_-]{24,}$/);

const nextPairReply = waitForType(reclaim.ws, "pair-key");
reclaim.ws.send(JSON.stringify({ type: "create-pair-key" }));
const nextPair = await nextPairReply;
assert.equal(nextPair.type, "pair-key");
assert.match(nextPair.pairKey, /^[A-Za-z0-9_-]{24,}$/);
assert.notEqual(nextPair.pairKey, host.reply.pairKey);

const second = await request({ type: "join-room", code: host.reply.code, pairKey: nextPair.pairKey });
assert.equal(second.reply.type, "room");
assert.match(second.reply.deviceKey, /^[A-Za-z0-9_-]{24,}$/);
assert.notEqual(second.reply.deviceKey, first.reply.deviceKey);

first.ws.close();
second.ws.close();
const deletedReply = waitForType(reclaim.ws, "registration-deleted");
reclaim.ws.send(JSON.stringify({ type: "delete-registration" }));
assert.equal((await deletedReply).type, "registration-deleted");
reclaim.ws.close();
console.log("live-host-auth-multi-device-pairing-ok");
