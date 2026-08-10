import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { WebSocket } from "ws";

const testDirectory = mkdtempSync(join(tmpdir(), "touchdeck-persistence-test-"));
const deviceStore = join(testDirectory, "devices.json");
const port = 30000 + Math.floor(Math.random() * 10000);
const url = `ws://127.0.0.1:${port}`;
const hostKey = "persistent-host-key-for-test-123456789";
let server;

function startServer(required = false) {
  server = spawn(process.execPath, ["signal.mjs"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      PORT: String(port),
      TOUCHDECK_DEVICE_STORE: deviceStore,
      TOUCHDECK_DEVICE_STORE_REQUIRED: required ? "1" : "0",
      TOUCHDECK_ROOM_TTL_MS: "120",
      TOUCHDECK_SWEEP_INTERVAL_MS: "30",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
}

async function waitForServer() {
  let stderr = "";
  server.stderr.on("data", (chunk) => { stderr += chunk; });
  for (let i = 0; i < 50; i++) {
    try {
      const ws = new WebSocket(url);
      await once(ws, "open");
      ws.close();
      return;
    } catch { await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  throw new Error(`persistent signal test server did not start: ${stderr}`);
}

async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = once(server, "exit");
  server.kill();
  await exited;
}

async function connect(message) {
  const ws = new WebSocket(url);
  await once(ws, "open");
  ws.send(JSON.stringify(message));
  const [raw] = await once(ws, "message");
  return { ws, reply: JSON.parse(raw.toString()) };
}

function waitForMessage(ws, predicate) {
  return new Promise((resolve) => {
    const listener = (raw) => {
      const message = JSON.parse(raw.toString());
      if (!predicate(message)) return;
      ws.off("message", listener);
      resolve(message);
    };
    ws.on("message", listener);
  });
}

async function request(ws, message, type) {
  const response = waitForMessage(ws, (candidate) => candidate.type === type || candidate.type === "error");
  ws.send(JSON.stringify(message));
  return response;
}

async function closeSocket(ws) {
  if (!ws || ws.readyState === WebSocket.CLOSED) return;
  const closed = once(ws, "close");
  ws.close();
  await closed;
}

test("registered devices and pending pair survive TTL and signal restarts", async () => {
  startServer();
  await waitForServer();
  const firstHost = await connect({ type: "create-room", hostKey });
  const code = firstHost.reply.code;
  const firstPairKey = firstHost.reply.pairKey;
  const first = await connect({ type: "join-room", code, pairKey: firstPairKey });
  const firstDeviceKey = first.reply.deviceKey;
  const secondPair = await request(firstHost.ws, { type: "create-pair-key" }, "pair-key");
  const second = await connect({ type: "join-room", code, pairKey: secondPair.pairKey });
  const secondDeviceKey = second.reply.deviceKey;

  // 旧实现会在固定 TTL 后删掉仍在线的活房；Host 在线时现在必须滚动续期。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterTtl = await connect({ type: "join-room", code, deviceKey: firstDeviceKey });
  assert.equal(afterTtl.reply.type, "room");
  await Promise.all([closeSocket(first.ws), closeSocket(second.ws), closeSocket(afterTtl.ws)]);

  const closed = await request(firstHost.ws, { type: "close-room" }, "peer-left");
  assert.equal(closed.type, "peer-left");
  await closeSocket(firstHost.ws);
  const reopenedHost = await connect({ type: "create-room", code, hostKey });
  const afterExplicitClose = await connect({ type: "join-room", code, deviceKey: secondDeviceKey });
  assert.equal(afterExplicitClose.reply.type, "room");
  await closeSocket(afterExplicitClose.ws);

  const pendingPair = await request(reopenedHost.ws, { type: "create-pair-key" }, "pair-key");
  await closeSocket(reopenedHost.ws);
  await stopServer();

  const stored = readFileSync(deviceStore, "utf8");
  for (const secret of [hostKey, firstPairKey, secondPair.pairKey, pendingPair.pairKey, firstDeviceKey, secondDeviceKey]) {
    assert.equal(stored.includes(secret), false);
  }

  startServer(true);
  await waitForServer();
  const restoredHost = await connect({ type: "create-room", code, hostKey });
  assert.equal(restoredHost.reply.code, code);
  assert.equal(restoredHost.reply.pairKeyActive, true);

  const restoredFirst = await connect({ type: "join-room", code, deviceKey: firstDeviceKey });
  const restoredSecond = await connect({ type: "join-room", code, deviceKey: secondDeviceKey });
  assert.equal(restoredFirst.reply.type, "room");
  assert.equal(restoredSecond.reply.type, "room");
  const third = await connect({ type: "join-room", code, pairKey: pendingPair.pairKey });
  assert.equal(third.reply.type, "room");

  const imposter = await connect({ type: "create-room", code, hostKey: "different-persistent-host-key-987654321" });
  assert.deepEqual(imposter.reply, { type: "error", reason: "host-auth-failed" });

  const revoked = await request(restoredHost.ws, { type: "revoke-devices" }, "devices-revoked");
  assert.equal(revoked.type, "devices-revoked");
  await Promise.all([closeSocket(restoredFirst.ws), closeSocket(restoredSecond.ws), closeSocket(third.ws), closeSocket(imposter.ws)]);
  await closeSocket(restoredHost.ws);
  await stopServer();

  startServer(true);
  await waitForServer();
  const finalHost = await connect({ type: "create-room", code, hostKey });
  const rejected = await connect({ type: "join-room", code, deviceKey: firstDeviceKey });
  assert.deepEqual(rejected.reply, { type: "error", reason: "pairing-required" });
  await Promise.all([closeSocket(rejected.ws), closeSocket(finalHost.ws)]);
});

after(async () => {
  await stopServer();
  rmSync(testDirectory, { recursive: true, force: true });
});
