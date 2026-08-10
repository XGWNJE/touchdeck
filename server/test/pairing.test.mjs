import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { after, test } from "node:test";
import { WebSocket } from "ws";

const port = 20000 + Math.floor(Math.random() * 10000);
const url = `ws://127.0.0.1:${port}`;
const server = spawn(process.execPath, ["signal.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: { ...process.env, PORT: String(port), TOUCHDECK_TURN_SHARED_SECRET: "test-turn-secret-not-for-production" },
  stdio: ["ignore", "ignore", "pipe"],
});

async function waitForServer() {
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 40; i++) {
    try {
      const ws = new WebSocket(url);
      await once(ws, "open");
      ws.close();
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  throw new Error(`signal test server did not start: ${stderr}`);
}

async function connect(message) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  ws.send(JSON.stringify(message));
  const [raw] = await once(ws, "message");
  return { ws, reply: JSON.parse(raw.toString()) };
}

async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve) => {
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      ws.off("message", onMessage);
      resolve(message);
    };
    ws.on("message", onMessage);
  });
}

async function request(ws, message, responseType) {
  const response = waitForMessage(ws, (candidate) => candidate.type === responseType || candidate.type === "error");
  ws.send(JSON.stringify(message));
  return response;
}

const hostKey = "host-key-for-automated-pairing-test-123456";
let host;
let created;

test("signal service supports one-time multi-device pairing without breaking device reconnect", async () => {
  await waitForServer();
  ({ ws: host, reply: created } = await connect({ type: "create-room", hostKey }));
  assert.equal(created.type, "room");
  assert.match(created.code, /^\d{6}$/);
  assert.match(created.pairKey, /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(created.pairTtlMs, 5 * 60 * 1000);
  assert.match(created.hostFingerprint, /^[A-F0-9]{16}$/);
  assert.match(created.turn.username, /^\d+:[a-f0-9]+$/);
  assert.ok(created.turn.credential.length > 20);

  const firstPeer = waitForMessage(host, (message) => message.type === "peer");
  const first = await connect({ type: "join-room", code: created.code, pairKey: created.pairKey });
  assert.equal(first.reply.type, "room");
  assert.match(first.reply.deviceKey, /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(first.reply.hostFingerprint, created.hostFingerprint);
  assert.equal((await firstPeer).paired, true);
  await closeSocket(first.ws);

  const consumed = await connect({ type: "join-room", code: created.code, pairKey: created.pairKey });
  assert.deepEqual(consumed.reply, { type: "error", reason: "pairing-required" });
  await closeSocket(consumed.ws);

  const nextPair = await request(host, { type: "create-pair-key" }, "pair-key");
  assert.equal(nextPair.type, "pair-key");
  assert.match(nextPair.pairKey, /^[A-Za-z0-9_-]{24,}$/);
  assert.notEqual(nextPair.pairKey, created.pairKey);
  assert.equal(nextPair.pairTtlMs, 5 * 60 * 1000);
  assert.equal("previousPairKey" in nextPair, false);

  const replacementPair = await request(host, { type: "create-pair-key" }, "pair-key");
  assert.notEqual(replacementPair.pairKey, nextPair.pairKey);

  const reconnectPeer = waitForMessage(host, (message) => message.type === "peer");
  const reconnect = await connect({ type: "join-room", code: created.code, deviceKey: first.reply.deviceKey });
  assert.equal(reconnect.reply.type, "room");
  assert.equal((await reconnectPeer).paired, false);
  await closeSocket(reconnect.ws);

  const replaced = await connect({ type: "join-room", code: created.code, pairKey: nextPair.pairKey });
  assert.deepEqual(replaced.reply, { type: "error", reason: "pairing-required" });
  await closeSocket(replaced.ws);

  const secondPeer = waitForMessage(host, (message) => message.type === "peer");
  const second = await connect({ type: "join-room", code: created.code, pairKey: replacementPair.pairKey });
  assert.equal(second.reply.type, "room");
  assert.match(second.reply.deviceKey, /^[A-Za-z0-9_-]{24,}$/);
  assert.notEqual(second.reply.deviceKey, first.reply.deviceKey);
  assert.equal((await secondPeer).paired, true);
  await closeSocket(second.ws);

  const legalReconnects = [];
  for (let i = 0; i < 8; i++) {
    const legal = await connect({ type: "join-room", code: created.code, deviceKey: i % 2 === 0 ? first.reply.deviceKey : second.reply.deviceKey });
    assert.equal(legal.reply.type, "room");
    legalReconnects.push(legal.ws);
  }
  const full = await request(host, { type: "create-pair-key" }, "pair-key");
  assert.deepEqual(full, { type: "error", reason: "room-full" });
  await Promise.all(legalReconnects.map(closeSocket));

  for (let i = 0; i < 5; i++) {
    const failed = await connect({ type: "join-room", code: created.code, pairKey: replacementPair.pairKey });
    assert.deepEqual(failed.reply, { type: "error", reason: "pairing-required" });
    await closeSocket(failed.ws);
  }
  const rateLimited = await connect({ type: "join-room", code: created.code, pairKey: replacementPair.pairKey });
  assert.deepEqual(rateLimited.reply, { type: "error", reason: "too-many-attempts" });
  await closeSocket(rateLimited.ws);

  const unauthenticated = await connect({ type: "create-pair-key" });
  assert.deepEqual(unauthenticated.reply, { type: "error", reason: "host-auth-required" });
  await closeSocket(unauthenticated.ws);
});

test("reclaim rejects a different host key", async () => {
  host.close();
  await once(host, "close");
  const imposter = await connect({ type: "create-room", code: created.code, hostKey: "different-host-key-for-automated-test-654321" });
  assert.deepEqual(imposter.reply, { type: "error", reason: "host-auth-failed" });
  imposter.ws.close();

});

after(() => {
  for (const child of [server]) child.kill();
});
