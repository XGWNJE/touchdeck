// 生成自包含演示页：client/index.html + 当前配置 + 全部图标打进单个 HTML。
// 产物塞进 Android 资产目录——广域网测试期 App 离线展示面板（通讯接通后切回在线加载）。
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resolveConfig, resolveIcon } from "../server.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = resolveConfig();
const icons = {};
for (const b of config.buttons) {
  icons[b.icon] = resolveIcon(config.themeName, b.icon);
}

const clientHtml = fs.readFileSync(path.join(ROOT, "client", "index.html"), "utf-8");
// JSON 内 </ 转义，防止提前闭合 <script>
const payload = JSON.stringify({ config, icons }).replace(/<\//g, "<\\/");
const demoTag = `<script>window.TOUCHDECK_DEMO=${payload};</script>`;
const out = clientHtml.replace("<script>", demoTag + "\n<script>");
if (out === clientHtml) throw new Error("未找到 <script> 注入点");

const dest = path.join(ROOT, "android", "app", "src", "main", "assets", "panel.html");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, out);
console.log("[demo] 已生成", path.relative(ROOT, dest), (fs.statSync(dest).size / 1024).toFixed(0) + "KB");
