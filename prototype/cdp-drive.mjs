// CDP 驱动器（原型期调试工具）：连 Electron 远程调试端口，在指定渲染器里执行 JS。
// 用法: node prototype/cdp-drive.mjs <url匹配子串> <JS表达式>
// 例: node prototype/cdp-drive.mjs console.html "document.getElementById('panelBtn').click()"
import { WebSocket } from "../server/node_modules/ws/wrapper.mjs";

const [match, expr] = process.argv.slice(2);
if (!match || !expr) {
  console.error("usage: node prototype/cdp-drive.mjs <url-substr> <js>");
  process.exit(1);
}

const port = process.env.CDP_PORT || "9222";
const list = await (await fetch(`http://localhost:${port}/json`)).json();
const target = list.find((t) => t.url.includes(match));
if (!target) {
  console.error("target not found for:", match, "available:", list.map((t) => t.url).join(", "));
  process.exit(1);
}

const ws = new WebSocket(target.webSocketDebuggerUrl);
const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("cdp timeout")), 15000);
  ws.on("open", () => {
    ws.send(JSON.stringify({
      id: 1, method: "Runtime.evaluate",
      params: { expression: expr, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id === 1) {
      clearTimeout(timer);
      resolve(msg.result);
    }
  });
  ws.on("error", reject);
});
ws.close();
if (result.exceptionDetails) {
  console.error("JS exception:", JSON.stringify(result.exceptionDetails.exception?.description || result.exceptionDetails.text));
  process.exit(1);
}
console.log(JSON.stringify(result.result?.value ?? result.result));
