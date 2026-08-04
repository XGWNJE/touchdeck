// TouchDeck 链路验证服务器（新架构：面板跑在平板浏览器，按键经局域网注入本机）
// 原型期与 Electron 版共用 touchdeck.config.json / themes/ / layouts/ / icons/，
// 配置解析与按键注入逻辑暂与 src/main.js 并存，正式版收敛为共享模块。
import http from "http";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath, pathToFileURL } from "url";
import { keyboard, Key } from "@nut-tree/nut-js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7758;

/* ---------- 配置解析（与 src/main.js 同源逻辑） ---------- */
function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}
function isPlainObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}
function deepMerge(base, over) {
  if (!isPlainObj(base) || !isPlainObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObj(v) && isPlainObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function resolveConfig() {
  const user = loadJson(path.join(ROOT, "touchdeck.config.json"));
  const themeName = user.theme || "default";
  const layoutName = user.layout || "left-dock";

  let theme;
  try {
    theme = loadJson(path.join(ROOT, "themes", themeName, "theme.json"));
  } catch (e) {
    console.error(`[server] 主题 "${themeName}" 加载失败（${e.message}），回退 default`);
    theme = loadJson(path.join(ROOT, "themes", "default", "theme.json"));
  }
  let layout;
  try {
    layout = loadJson(path.join(ROOT, "layouts", `${layoutName}.json`));
  } catch (e) {
    console.error(`[server] 布局 "${layoutName}" 加载失败（${e.message}），回退 left-dock`);
    layout = loadJson(path.join(ROOT, "layouts", "left-dock.json"));
  }

  const mergedTheme = deepMerge(theme, user.themeOverrides || {});
  const mergedLayout = deepMerge(layout, user.layoutOverrides || {});
  if (!Array.isArray(mergedLayout.buttons) || mergedLayout.buttons.length === 0) {
    throw new Error(`布局 "${layoutName}" 缺少 buttons 数组`);
  }
  return {
    behavior: { idleDimSeconds: 5, confirmSeconds: 2.5, ...(user.behavior || {}) },
    themeName,
    theme: mergedTheme,
    layout: mergedLayout,
    buttons: mergedLayout.buttons,
  };
}

/* ---------- 按键注入（与 src/main.js 同源逻辑） ---------- */
const KEY_MAP = {
  escape: "Escape", tab: "Tab", up: "Up", down: "Down",
  enter: "Return", backspace: "Backspace",
  s: "S", c: "C", v: "V", o: "O", a: "A",
};

async function sendKeys(keys) {
  if (keys.text) {
    await keyboard.type(keys.text);
    return;
  }
  const mods = [];
  if (keys.ctrl) mods.push(Key.LeftControl);
  if (keys.shift) mods.push(Key.LeftShift);
  if (keys.alt) mods.push(Key.LeftAlt);
  if (keys.win) mods.push(Key.LeftSuper);
  try {
    for (const m of mods) await keyboard.pressKey(m);
    if (keys.key) {
      const key = Key[KEY_MAP[keys.key] || keys.key];
      await keyboard.type(key);
    } else {
      // 纯修饰键组合（如微信输入法 Ctrl+Win+Shift 启动语音输入）：按住片刻即触发
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    for (const m of mods.reverse()) await keyboard.releaseKey(m);
  }
}

/* ---------- 图标解析（优先级：主题包 → 全局 icons/） ---------- */
const iconCache = new Map();
function resolveIcon(themeName, name) {
  if (!/^[a-z0-9-]+$/.test(name)) return null;
  const candidates = [
    path.join(ROOT, "themes", themeName, "icons", `${name}.svg`),
    path.join(ROOT, "themes", themeName, "icons", `${name}.png`),
    path.join(ROOT, "icons", `${name}.svg`),
  ];
  for (const p of candidates) {
    try {
      const buf = fs.readFileSync(p);
      if (p.endsWith(".svg")) return { kind: "svg", data: buf.toString("utf-8") };
      return { kind: "png", data: "data:image/png;base64," + buf.toString("base64") };
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/* ---------- HTTP 服务 ---------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/api/config") {
      const config = resolveConfig(); // 每次现读：改配置刷新平板页面即生效
      return sendJson(res, 200, config);
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/icon/")) {
      const name = url.pathname.slice("/api/icon/".length);
      const key = resolveConfig().themeName + "/" + name;
      if (!iconCache.has(key)) iconCache.set(key, resolveIcon(resolveConfig().themeName, name));
      return sendJson(res, 200, iconCache.get(key));
    }
    if (req.method === "POST" && url.pathname === "/api/press") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { id } = JSON.parse(body || "{}");
      const btn = resolveConfig().buttons.find((b) => b.id === id);
      if (!btn || !btn.keys) return sendJson(res, 200, { ok: false, reason: "unconfigured" });
      await sendKeys(btn.keys);
      console.log("[server] press", id);
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = fs.readFileSync(path.join(ROOT, "client", "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }
    sendJson(res, 404, { ok: false, reason: "not-found" });
  } catch (err) {
    console.error("[server] error:", err.message);
    sendJson(res, 500, { ok: false, reason: String(err.message || err) });
  }
});

const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  server.listen(PORT, "0.0.0.0", () => {
    const ips = Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === "IPv4" && !i.internal)
      .map((i) => i.address);
    console.log(`[server] TouchDeck 链路服务器已启动，端口 ${PORT}`);
    for (const ip of ips) console.log(`[server] 平板浏览器打开: http://${ip}:${PORT}`);
  });
}

// 供 scripts/build-demo-page.mjs 复用（生成 Android 离线演示页）
export { resolveConfig, resolveIcon };
