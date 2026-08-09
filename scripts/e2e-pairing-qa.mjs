// 仅本机验收辅助：从隔离 Electron 实例的 CDP 读取临时配对信息后直接填入模拟器。
// 永不打印房间码、配对密钥或续连凭据。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

const adbPath = process.env.ANDROID_ADB;
const serial = process.env.ANDROID_SERIAL || "emulator-5554";
const port = Number(process.env.TOUCHDECK_CDP_PORT || "9224");
assert.ok(adbPath, "ANDROID_ADB is required");

function adb(...args) {
  return execFileSync(adbPath, ["-s", serial, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const peer = targets.find((target) => target.url.includes("/peer/"));
assert.ok(peer, "peer renderer is not available through CDP");
const ws = new WebSocket(peer.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.send(JSON.stringify({
  id: 1,
  method: "Runtime.evaluate",
  params: { expression: "JSON.stringify({room:localStorage.getItem('touchdeck.roomCode'),pair:localStorage.getItem('touchdeck.pairKey')})", returnByValue: true },
}));
const response = await new Promise((resolve, reject) => { ws.onmessage = (event) => resolve(JSON.parse(event.data)); ws.onerror = reject; });
ws.close();
const credentials = JSON.parse(response.result.result.value);
if (!/^\d{6}$/.test(credentials.room) || !/^[A-Za-z0-9_-]{24,}$/.test(credentials.pair)) {
  throw new Error("fresh pairing material is invalid");
}

adb("shell", "pm", "clear", "cn.touchdeck.app");
adb("shell", "am", "start", "-n", "cn.touchdeck.app/.MainActivity");
await sleep(1000);
adb("shell", "input", "tap", "540", "598");
adb("shell", "input", "tap", "420", "774");
adb("shell", "input", "text", credentials.room);
adb("shell", "input", "tap", "420", "900");
adb("shell", "input", "text", credentials.pair);
adb("shell", "input", "keyevent", "4");
adb("logcat", "-c");
adb("shell", "input", "tap", "912", "775");
await sleep(12000);
const log = adb("logcat", "-d", "-s", "TouchDeckP2P:D", "*:S");
assert.match(log, /channel state: OPEN/);
assert.doesNotMatch(log, /signal error|ws error|heartbeat timeout/);
const ui = adb("exec-out", "uiautomator", "dump", "/dev/tty");
if (!/已核验主机 [A-F0-9]{16}/.test(ui)) throw new Error("Android did not display the verified host fingerprint");

// 同一首次密钥必须不能为第二个连接再开门；这里直接复用刚才的临时值，
// 不写入文件也不输出，验证的是已部署信令服务而非模拟实现。
const retry = new WebSocket("wss://api.xgwnje.cn/signal");
await new Promise((resolve, reject) => { retry.onopen = resolve; retry.onerror = reject; });
retry.send(JSON.stringify({ type: "join-room", code: credentials.room, pairKey: credentials.pair }));
const rejected = await new Promise((resolve, reject) => { retry.onmessage = (event) => resolve(JSON.parse(event.data)); retry.onerror = reject; });
retry.close();
assert.deepEqual(rejected, { type: "error", reason: "pairing-required" });

// Host 收到首个 client 后须丢弃本地一次性副本。
const verify = new WebSocket(peer.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { verify.onopen = resolve; verify.onerror = reject; });
verify.send(JSON.stringify({ id: 2, method: "Runtime.evaluate", params: { expression: "localStorage.getItem('touchdeck.pairKey')", returnByValue: true } }));
const cleaned = await new Promise((resolve, reject) => { verify.onmessage = (event) => resolve(JSON.parse(event.data)); verify.onerror = reject; });
verify.close();
assert.equal(cleaned.result.result.value, null);
console.log("first-pair-channel-open");
