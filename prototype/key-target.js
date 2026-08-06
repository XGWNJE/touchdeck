// 原型期按键靶窗：一个普通的可聚焦 Electron 窗口（alwaysOnTop 保证可见可点），
// 文本区收到的一切输入（键击/粘贴/组合键）实时显示，供宏引擎端到端验证。
// 用法: npx electron prototype/key-target.js  （CDP 端口 9223）
const { app, BrowserWindow } = require("electron");

const HTML = "data:text/html;charset=utf-8," + encodeURIComponent(`<!doctype html>
<meta charset="utf-8">
<title>TD-KeyTarget</title>
<body style="margin:0;background:#1b1b22;color:#eee;font:14px/1.5 monospace;display:flex;flex-direction:column;height:100vh">
<div id="log" style="flex:0 0 auto;max-height:40%;overflow:auto;padding:6px;border-bottom:1px solid #444;white-space:pre-wrap"></div>
<textarea id="ta" style="flex:1;background:#101014;color:#eee;border:0;outline:0;padding:10px;font:16px monospace" placeholder="key target"></textarea>
<script>
const logEl = document.getElementById("log");
const ta = document.getElementById("ta");
function log(s) { logEl.textContent += s + "\\n"; logEl.scrollTop = logEl.scrollHeight; }
for (const ev of ["keydown", "keyup", "paste", "input"]) {
  ta.addEventListener(ev, (e) => log(ev + (e.key ? ":" + e.key : "") + (e.ctrlKey ? "+ctrl" : "")));
}
window.__dump = () => ({ text: ta.value, log: logEl.textContent });
window.__reset = () => { ta.value = ""; logEl.textContent = ""; };
ta.focus();
<\/script>`);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 480, height: 420, x: 1180, y: 220,
    title: "TD-KeyTarget",
    alwaysOnTop: true, focusable: true, autoHideMenuBar: true,
  });
  win.loadURL(HTML);
});
app.on("window-all-closed", () => app.quit());
