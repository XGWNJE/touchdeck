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

const hostKey = "host-key-for-automated-pairing-test-123456";
let host;
let created;

test("signal service creates a one-time pair, returns expiring TURN credentials, and supports device reconnect", async () => {
  await waitForServer();
  ({ ws: host, reply: created } = await connect({ type: "create-room", hostKey }));
  assert.equal(created.type, "room");
  assert.match(created.code, /^\d{6}$/);
  assert.match(created.pairKey, /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(created.pairTtlMs, 5 * 60 * 1000);
  assert.match(created.hostFingerprint, /^[A-F0-9]{16}$/);
  assert.match(created.turn.username, /^\d+:[a-f0-9]+$/);
  assert.ok(created.turn.credential.length > 20);

  const first = await connect({ type: "join-room", code: created.code, pairKey: created.pairKey });
  assert.equal(first.reply.type, "room");
  assert.match(first.reply.deviceKey, /^[A-Za-z0-9_-]{24,}$/);
  assert.equal(first.reply.hostFingerprint, created.hostFingerprint);
  first.ws.close();

  const consumed = await connect({ type: "join-room", code: created.code, pairKey: created.pairKey });
  assert.deepEqual(consumed.reply, { type: "error", reason: "pairing-required" });
  consumed.ws.close();

  const reconnect = await connect({ type: "join-room", code: created.code, deviceKey: first.reply.deviceKey });
  assert.equal(reconnect.reply.type, "room");
  reconnect.ws.close();
});

test("reclaim rejects a different host key and join attempts are source-rate-limited", async () => {
  host.close();
  await once(host, "close");
  const imposter = await connect({ type: "create-room", code: created.code, hostKey: "different-host-key-for-automated-test-654321" });
  assert.deepEqual(imposter.reply, { type: "error", reason: "host-auth-failed" });
  imposter.ws.close();

  const results = [];
  for (let i = 0; i < 5; i++) {
    const attempt = await connect({ type: "join-room", code: created.code, pairKey: "wrong-pair-key-for-rate-limit-test-000000" });
    results.push(attempt.reply.reason);
    attempt.ws.close();
  }
  assert.equal(results.at(-1), "too-many-attempts");
  assert.ok(results.includes("pairing-required"));
});

after(() => {
  for (const child of [server]) child.kill();
});
