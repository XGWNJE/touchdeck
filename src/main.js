// TouchDeck 主进程：无框置顶工具条，点击不抢焦点，按键经 nut-js 发到目标窗口
const { app, BrowserWindow, ipcMain, screen, desktopCapturer } = require("electron");
const path = require("path");
const fs = require("fs");

// koffi：调 Win32 SetWindowPos 做主进程轮询拖拽，
// 渲染进程 IPC setPosition 拖拽会导致透明窗面变形，禁走那条路
let SendMessageW = null;
let ReleaseCapture = null;
let SetWindowPos = null;
function ensureWin32() {
  if (!SetWindowPos) {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    // HWND 必须按数值传（getNativeWindowHandle 返回的 Buffer 内容是句柄值，
    // 直接传 Buffer 会把「缓冲区地址」当句柄，调用静默失败——2026-08-02 实证）
    SendMessageW = user32.func("__stdcall", "SendMessageW", "long", ["uintptr_t", "uint", "uintptr_t", "long"]);
    ReleaseCapture = user32.func("__stdcall", "ReleaseCapture", "bool", []);
    SetWindowPos = user32.func("__stdcall", "SetWindowPos", "bool",
      ["uintptr_t", "uintptr_t", "int", "int", "int", "int", "uint"]);
  }
}

function hwndOf(window) {
  return Number(window.getNativeWindowHandle().readBigUInt64LE(0));
}

const CONFIG_PATH = path.join(__dirname, "..", "touchdeck.config.json");
const STATE_PATH = path.join(__dirname, "..", "touchdeck.state.json");
const ROOT = path.join(__dirname, "..");

// 面板位置持久化：拖动结束写入，启动时恢复；与面向用户的 config 分离（机器状态不手改）
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    if (Number.isFinite(s.x) && Number.isFinite(s.y)) return s;
  } catch { /* 无状态文件属正常 */ }
  return null;
}

function saveState(pos) {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify(pos));
  } catch (e) {
    console.error("[touchdeck] 位置持久化失败:", e.message);
  }
}

// 记忆的窗口位置仍有足够区域落在某块屏幕内才算有效（防拔显示器后窗口飞走）
function isPositionUsable(x, y, width, height) {
  const disp = screen.getDisplayNearestPoint({ x, y });
  const a = disp.workArea;
  const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
  const overlapY = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
  return overlapX >= 80 && overlapY >= 80;
}

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

// 配置解析：用户配置只选主题/布局 + 微调，视觉在 themes/，编排在 layouts/。
// 资源缺失时显式报错并回退默认，不静默降级。
function resolveConfig() {
  const user = loadJson(CONFIG_PATH);
  const themeName = user.theme || "default";
  const layoutName = user.layout || "left-dock";

  let theme;
  try {
    theme = loadJson(path.join(ROOT, "themes", themeName, "theme.json"));
  } catch (e) {
    console.error(`[touchdeck] 主题 "${themeName}" 加载失败（${e.message}），回退 default`);
    theme = loadJson(path.join(ROOT, "themes", "default", "theme.json"));
  }

  let layout;
  try {
    layout = loadJson(path.join(ROOT, "layouts", `${layoutName}.json`));
  } catch (e) {
    console.error(`[touchdeck] 布局 "${layoutName}" 加载失败（${e.message}），回退 left-dock`);
    layout = loadJson(path.join(ROOT, "layouts", "left-dock.json"));
  }

  const mergedTheme = deepMerge(theme, user.themeOverrides || {});
  const mergedLayout = deepMerge(layout, user.layoutOverrides || {});
  if (!Array.isArray(mergedLayout.buttons) || mergedLayout.buttons.length === 0) {
    throw new Error(`布局 "${layoutName}" 缺少 buttons 数组`);
  }

  return {
    behavior: { idleDimSeconds: 5, confirmSeconds: 2.5, dragHoldMs: 500, ...(user.behavior || {}) },
    themeName,
    theme: mergedTheme,
    layout: mergedLayout,
    buttons: mergedLayout.buttons,
  };
}

// nut-js 是 ESM 包，CJS 主进程里用动态 import
let nutKeyboard = null;
let nutKey = null;
async function ensureNut() {
  if (!nutKeyboard) {
    const nut = await import("@nut-tree/nut-js");
    nutKeyboard = nut.keyboard;
    nutKey = nut.Key;
  }
}

const KEY_MAP = {
  escape: "Escape",
  tab: "Tab",
  up: "Up",
  down: "Down",
  enter: "Return",
  backspace: "Backspace",
  s: "S", c: "C", v: "V", o: "O", a: "A",
};

async function sendKeys(keys) {
  await ensureNut();
  if (keys.text) {
    await nutKeyboard.type(keys.text);
    return;
  }
  const mods = [];
  if (keys.ctrl) mods.push(nutKey.LeftControl);
  if (keys.shift) mods.push(nutKey.LeftShift);
  if (keys.alt) mods.push(nutKey.LeftAlt);
  if (keys.win) mods.push(nutKey.LeftSuper);
  try {
    for (const m of mods) await nutKeyboard.pressKey(m);
    if (keys.key) {
      const key = nutKey[KEY_MAP[keys.key] || keys.key];
      await nutKeyboard.type(key);
    } else {
      // 纯修饰键组合（如微信输入法 Ctrl+Win+Shift 启动语音输入）：按住片刻即触发
      await new Promise((r) => setTimeout(r, 60));
    }
  } finally {
    for (const m of mods.reverse()) await nutKeyboard.releaseKey(m);
  }
}

let win = null;

function createWindow() {
  const config = resolveConfig();
  const ui = config.layout;
  const size = Math.round(ui.buttonSize * ui.scale);
  const cols = ui.columns;
  const rows = Math.ceil(config.buttons.length / cols);
  const handleSize = ui.handle && ui.handle.size ? ui.handle.size : 0; // 小揪揪手柄高度（纵向面板）
  const width = cols * size + (cols - 1) * ui.gap + ui.padding * 2;
  const height = rows * size + (rows - 1) * ui.gap + ui.padding * 2 + handleSize;

  const area = screen.getPrimaryDisplay().workArea;
  let x, y;
  if (ui.position === "left") {
    x = area.x + 24;
    y = Math.round(area.y + (area.height - height) / 2);
  } else if (ui.position === "right") {
    x = Math.round(area.x + area.width - width - 24);
    y = Math.round(area.y + (area.height - height) / 2);
  } else { // 默认底部居中
    x = Math.round(area.x + (area.width - width) / 2);
    y = Math.round(area.y + area.height - height - 24);
  }

  // 位置持久化：有有效记忆位置则覆盖布局默认位
  const saved = loadState();
  if (saved && isPositionUsable(saved.x, saved.y, width, height)) {
    x = saved.x;
    y = saved.y;
  }

  win = new BrowserWindow({
    width, height, x, y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,        // 铁律 1：点击不抢焦点
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  // 锁死缩放：UU 多点触控可能被 Chromium 解释为捏合缩放，表现为面板持续放大
  win.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  win.webContents.setZoomFactor(1);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.on("did-finish-load", () => { console.log("[touchdeck] renderer loaded"); sendBounds(); });
  win.webContents.on("did-fail-load", (_e, code, desc) => console.log("[touchdeck] load failed", code, desc));
  win.webContents.on("console-message", (_e, _l, msg) => console.log("[touchdeck:renderer]", msg));
  console.log("[touchdeck] window bounds", JSON.stringify(win.getBounds()));

  // 推送窗口位置给渲染端（小揪揪靠边翻面用）：启动一次 + 每次拖动结束（防抖）一次
  const sendBounds = () => {
    const b = win.getBounds();
    const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
    win.webContents.send("win-bounds", { ...b, area: wa });
  };

  // 任何移动（长按抓起拖动 / 空白处与小揪揪原生拖动）都持久化位置，防抖 300ms
  let moveSaveTimer = null;
  win.on("moved", () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      const [mx, my] = win.getPosition();
      saveState({ x: mx, y: my });
      sendBounds();
    }, 300);
  });

  // 临时诊断：截全屏验证窗口真实可见性（desktopCapturer 走 WGC，能抓透明分层窗口）
  const debugShot = async (name) => {
    const size = screen.getPrimaryDisplay().size;
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    fs.writeFileSync(path.join(__dirname, "..", "prototype", name), sources[0].thumbnail.toPNG());
  };
  ipcMain.handle("debug-shot", () => debugShot("screen-dbg.png"));
  // 临时诊断：启动 18 秒后再截一张（留出模拟拖拽的时间窗口，验证拖拽不变形）
  setTimeout(() => debugShot("screen-drag.png").catch(() => {}), 18000);

  ipcMain.handle("get-config", () => config);

  // 图标解析（优先级从高到低）：themes/<当前主题>/icons/<name>.svg|png → icons/<name>.svg。
  // 返回 { kind: "svg"|"png", data }；找不到返回 null（渲染端回退 emoji 文字）。
  const iconCache = new Map();
  function resolveIcon(name) {
    if (!/^[a-z0-9-]+$/.test(name)) return null;
    const candidates = [
      path.join(ROOT, "themes", config.themeName, "icons", `${name}.svg`),
      path.join(ROOT, "themes", config.themeName, "icons", `${name}.png`),
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
  ipcMain.handle("get-icon", (_e, name) => {
    if (!iconCache.has(name)) iconCache.set(name, resolveIcon(name));
    return iconCache.get(name);
  });

  ipcMain.handle("press", async (_e, buttonId) => {
    const btn = config.buttons.find((b) => b.id === buttonId);
    if (!btn || !btn.keys) return { ok: false, reason: "unconfigured" };
    try {
      await sendKeys(btn.keys);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });

  // 按钮上长按抓起后，由渲染进程调用：主进程轮询光标，用 Win32 SetWindowPos 移动
  // （Electron setPosition 走 Chromium 窗口路径，透明窗上高频调用会累积缩放伪影；
  //   Modal 移动循环 WM_NCLBUTTONDOWN/SC_MOVE 在 focusable:false 窗口上无效，均不可走）
  // SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_NOOWNERZORDER = 0x0215
  // （误用 0x0233 会带上 SWP_NOMOVE(0x0002)：调用返回成功但位置永远不变——2026-08-02 实证）
  let dragTimer = null;
  const endDrag = (tag) => {
    if (!dragTimer) return;
    clearInterval(dragTimer);
    dragTimer = null;
    const [ex, ey] = win.getPosition();
    saveState({ x: ex, y: ey }); // SetWindowPos 移动未必触发 moved 事件，这里兜底持久化
    console.log("[touchdeck] drag end" + tag, JSON.stringify([ex, ey]));
  };
  ipcMain.on("start-drag", () => {
    if (!win) return;
    ensureWin32();
    ReleaseCapture();
    const hwnd = hwndOf(win);
    const startCursor = screen.getCursorScreenPoint();
    const [wx, wy] = win.getPosition();
    let lastX = wx, lastY = wy;
    let dbgTick = 0; // 临时诊断：覆盖整个移动阶段，含 winpos 与 SetWindowPos 返回值
    let stillTicks = 0; // 静止计时：光标 ~800ms 无移动自动收尾（松手信号丢失时防拖拽僵死）
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      try {
        const pt = screen.getCursorScreenPoint();
        const nx = Math.round(wx + pt.x - startCursor.x);
        const ny = Math.round(wy + pt.y - startCursor.y);
        dbgTick++;
        if (dbgTick > 750) { endDrag(" (timeout)"); return; } // 硬上限 ~12s
        if (dbgTick <= 200 && (dbgTick <= 3 || pt.x !== startCursor.x || pt.y !== startCursor.y)) {
          console.log("[touchdeck] tick", dbgTick, "cursor", pt.x, pt.y, "target", nx, ny, "winpos", JSON.stringify(win.getPosition()));
        }
        if (nx === lastX && ny === lastY) {
          stillTicks++;
          if (stillTicks > 50) endDrag(" (idle)");
          return;
        }
        stillTicks = 0;
        lastX = nx; lastY = ny;
        const ret = SetWindowPos(hwnd, 0, nx, ny, 0, 0, 0x0215);
        console.log("[touchdeck] SetWindowPos ret", ret, "winpos now", JSON.stringify(win.getPosition()));
      } catch (err) {
        console.error("[touchdeck] drag tick error:", err && err.message ? err.message : String(err));
      }
    }, 16);
    console.log("[touchdeck] drag start", JSON.stringify([wx, wy]));
  });

  // 结束拖拽的唯一信号：渲染端松手（pointerup）或下一次按下兜底。
  // UU 触控注入下 GetAsyncKeyState 读不到按键状态（2026-08-02 实测），不能用它判松手
  ipcMain.on("stop-drag", () => { console.log("[touchdeck] stop-drag received, timer running:", !!dragTimer); endDrag(" (stop-drag)"); });
}

// 单实例锁：重复启动直接退出，避免桌面快捷方式连点开出两个面板
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.whenReady().then(createWindow);
app.on("window-all-closed", () => app.quit());
