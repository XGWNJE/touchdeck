// 检查隔离 Host 的首次密钥是否存在或已按有效期清除；不输出任何凭据。
import assert from "node:assert/strict";

const port = Number(process.env.TOUCHDECK_CDP_PORT || "9227");
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const peer = targets.find((target) => target.url.includes("/peer/"));
assert.ok(peer, "peer renderer is not available through CDP");
const ws = new WebSocket(peer.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "localStorage.getItem('touchdeck.pairKey')", returnByValue: true } }));
const response = await new Promise((resolve, reject) => { ws.onmessage = (event) => resolve(JSON.parse(event.data)); ws.onerror = reject; });
ws.close();
const expectPresent = process.argv.includes("--expect-present");
if (expectPresent && response.result.result.value === null) throw new Error("initial pair key was not created");
if (!expectPresent && response.result.result.value !== null) throw new Error("expired pair key was not cleared");
console.log(expectPresent ? "initial-pair-key-present" : "expired-pair-key-cleared");
