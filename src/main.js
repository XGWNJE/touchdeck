// TouchDeck 主进程：无框置顶工具条，点击不抢焦点，按键经 nut-js 发到目标窗口
const { app, BrowserWindow, ipcMain, screen, desktopCapturer, clipboard, globalShortcut, Tray, Menu, nativeImage } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");

// koffi：调 Win32 SetWindowPos 做主进程轮询拖拽，
// 渲染进程 IPC setPosition 拖拽会导致透明窗面变形，禁走那条路
let SendMessageW = null;
let ReleaseCapture = null;
let SetWindowPos = null;
let GetAsyncKeyState = null;
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
    // 拖球松手检测兜底：SetWindowPos 移动窗口会中断渲染端 pointer capture
    // （pointerup 丢失），本地鼠标场景用左键状态补一个可靠的收尾信号
    GetAsyncKeyState = user32.func("__stdcall", "GetAsyncKeyState", "short", ["int"]);
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
    ui: { mode: "grid", input: "mouse", ...(user.ui || {}) },
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

// 通用 IPC（grid 与 bubble 两种模式共用）：配置/图标/注入/拖拽。
// 在 app.whenReady 统一注册，不再挂某个窗口的创建流程上。
function registerCommonIpc() {
  ipcMain.handle("get-config", () => resolveConfig());

  // 图标解析（优先级从高到低）：themes/<当前主题>/icons/<name>.svg|png → icons/<name>.svg。
  // 返回 { kind: "svg"|"png", data }；找不到返回 null（渲染端回退 emoji 文字）。
  const iconCache = new Map();
  function resolveIcon(name) {
    if (!/^[a-z0-9-]+$/.test(name)) return null;
    const themeName = resolveConfig().themeName;
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
  ipcMain.handle("get-icon", (_e, name) => {
    if (!iconCache.has(name)) iconCache.set(name, resolveIcon(name));
    return iconCache.get(name);
  });

  ipcMain.handle("press", async (_e, buttonId) => {
    const btn = resolveConfig().buttons.find((b) => b.id === buttonId);
    if (!btn || !btn.keys) return { ok: false, reason: "unconfigured" };
    try {
      await sendKeys(btn.keys);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: String(err) };
    }
  });

  // 临时诊断：截全屏验证窗口真实可见性（desktopCapturer 走 WGC，能抓透明分层窗口）
  ipcMain.handle("debug-shot", async () => {
    const size = screen.getPrimaryDisplay().size;
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
    fs.writeFileSync(path.join(__dirname, "..", "prototype", "screen-dbg.png"), sources[0].thumbnail.toPNG());
  });

  // 按钮上长按抓起后，由渲染进程调用：主进程轮询光标，用 Win32 SetWindowPos 移动
  // （Electron setPosition 走 Chromium 窗口路径，透明窗上高频调用会累积缩放伪影；
  //  Modal 移动循环 WM_NCLBUTTONDOWN/SC_MOVE 在 focusable:false 窗口上无效，均不可走）
  // SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_NOOWNERZORDER = 0x0215
  // （误用 0x0233 会带上 SWP_NOMOVE(0x0002)：调用返回成功但位置永远不变——2026-08-02 实证）
  const dragTarget = () => bubbleWin || win;
  let dragTimer = null;
  const endDrag = (tag) => {
    if (!dragTimer) return;
    clearInterval(dragTimer);
    dragTimer = null;
    const w = dragTarget();
    if (!w) return;
    const [ex, ey] = w.getPosition();
    saveState({ x: ex, y: ey }); // SetWindowPos 移动未必触发 moved 事件，这里兜底持久化
    console.log("[touchdeck] drag end" + tag, JSON.stringify([ex, ey]));
  };
  ipcMain.on("start-drag", () => {
    const w = dragTarget();
    if (!w) return;
    ensureWin32();
    ReleaseCapture();
    const hwnd = hwndOf(w);
    const startCursor = screen.getCursorScreenPoint();
    const [wx, wy] = w.getPosition();
    let lastX = wx, lastY = wy;
    let dbgTick = 0; // 临时诊断：覆盖整个移动阶段，含 winpos 与 SetWindowPos 返回值
    let stillTicks = 0; // 静止计时：光标 ~800ms 无移动自动收尾（松手信号丢失时防拖拽僵死）
    clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      try {
        // 松手检测（兜底①：pointerup 被 SetWindowPos 中断时）：
        // 本地鼠标场景左键抬起立即收尾；UU 触控注入读不到按键状态（已知边界），
        // 由 idle 兜底收尾
        const vk = GetAsyncKeyState(0x01);
        if (!(vk & 0x8000)) { endDrag(" (key-up)"); return; }
        const pt = screen.getCursorScreenPoint();
        const nx = Math.round(wx + pt.x - startCursor.x);
        const ny = Math.round(wy + pt.y - startCursor.y);
        dbgTick++;
        if (dbgTick > 750) { endDrag(" (timeout)"); return; } // 硬上限 ~12s
        if (nx === lastX && ny === lastY) {
          stillTicks++;
          if (stillTicks > 25) endDrag(" (idle)"); // 光标静止 ~400ms 自动收尾
          return;
        }
        stillTicks = 0;
        lastX = nx; lastY = ny;
        // SetWindowPos 是 Win32 API，入参必须是物理像素；而 getPosition/getCursorScreenPoint
        // 返回逻辑像素（DPI 缩放后）。100% 缩放两者相等；缩放 >100% 时不换算会出现拖动偏移
        // （球不在手指下、移动量偏小）——2026-08-05 报告
        const scale = screen.getDisplayNearestPoint({ x: nx, y: ny }).scaleFactor || 1;
        SetWindowPos(hwnd, 0, Math.round(nx * scale), Math.round(ny * scale), 0, 0, 0x0215);
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

  // 临时诊断：启动 18 秒后再截一张（留出模拟拖拽的时间窗口，验证拖拽不变形）
  setTimeout(() => {
    (async () => {
      const size = screen.getPrimaryDisplay().size;
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
      fs.writeFileSync(path.join(__dirname, "..", "prototype", "screen-drag.png"), sources[0].thumbnail.toPNG());
    })().catch(() => {});
  }, 18000);
}

// ===== 悬浮球模式（ui.mode === "bubble"）：交互基准 = 安卓悬浮球 App =====
// 球窗口（小圆球，可拖）+ 全屏透明菜单窗口（展开时创建，收起销毁）。
// 滑选手势桥：bubble 渲染端 pointerdown 即捕获指针，菜单窗口盖上来后
// 触摸流仍在球窗口（setPointerCapture 保底），move/up 经 IPC 转发给菜单窗口
// 做高亮跟随与松手确认——对应安卓的 skipBubbleRetop。
let bubbleWin = null;
let menuWin = null;
let menuPointerMode = "docked"; // docked=常驻点选 / slide=滑选（锚定起点）

function bubbleAnchor() {
  const b = bubbleWin.getBounds();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

function createBubbleWindow() {
  const config = resolveConfig();
  const layout = config.layout;
  const ballSize = Math.round((layout.bubble?.ballSize || 100) * (layout.scale || 1));
  const area = screen.getPrimaryDisplay().workArea;
  let x = area.x + area.width - ballSize - 24;
  let y = Math.round(area.y + (area.height - ballSize) / 2);
  const saved = loadState();
  if (saved && isPositionUsable(saved.x, saved.y, ballSize, ballSize)) {
    x = saved.x;
    y = saved.y;
  }

  bubbleWin = new BrowserWindow({
    width: ballSize, height: ballSize, x, y,
    frame: false, transparent: true, alwaysOnTop: true,
    focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  bubbleWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  bubbleWin.loadFile(path.join(__dirname, "renderer", "bubble.html"));
  bubbleWin.webContents.on("console-message", (_e, _l, msg) => console.log("[bubble]", msg));

  // 拖球结束后持久化位置（SetWindowPos 轮询移动未必触发 moved 事件，stop-drag 里已兜底）
  let moveSaveTimer = null;
  bubbleWin.on("moved", () => {
    clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      const [mx, my] = bubbleWin.getPosition();
      saveState({ x: mx, y: my });
    }, 300);
  });

  ipcMain.on("open-menu", (_e, mode) => {
    openMenuWindow(mode || "docked");
  });
  ipcMain.on("toggle-menu", () => {
    if (menuWin && !menuWin.isDestroyed()) closeMenuWindow();
    else openMenuWindow("docked");
  });
  ipcMain.on("close-menu", () => closeMenuWindow());
  // 滑选桥：bubble 渲染端转发手指位置给菜单窗口（菜单窗口自身收不到球上触摸流）
  ipcMain.on("menu-pointer", (_e, px, py, action) => {
    if (!menuWin || menuWin.isDestroyed()) return;
    menuWin.webContents.send("menu-pointer", px, py, action);
  });

  console.log("[touchdeck] bubble window", JSON.stringify(bubbleWin.getBounds()));
}

function openMenuWindow(mode) {
  if (menuWin && !menuWin.isDestroyed()) return;
  menuPointerMode = mode;
  const b = screen.getPrimaryDisplay().bounds;
  menuWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, alwaysOnTop: true,
    focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  menuWin.setAlwaysOnTop(true, "screen-saver");
  menuWin.loadFile(path.join(__dirname, "renderer", "menu.html"));
  menuWin.webContents.on("console-message", (_e, _l, msg) => console.log("[menu]", msg));
  menuWin.webContents.once("did-finish-load", () => {
    console.log("[touchdeck] menu window bounds", JSON.stringify(menuWin.getBounds()));
    menuWin.webContents.send("menu-init", {
      anchor: bubbleAnchor(),
      mode,
      input: resolveConfig().ui.input || "mouse",
      ballSize: bubbleWin.getBounds().width,
      screen: { width: b.width, height: b.height },
    });
  });
}

function closeMenuWindow() {
  if (menuWin && !menuWin.isDestroyed()) {
    menuWin.destroy();
  }
  menuWin = null;
}

ipcMain.on("menu-select", async (_e, buttonId) => {
  const btn = resolveConfig().buttons.find((b) => b.id === buttonId);
  if (btn && btn.keys) {
    try {
      await sendKeys(btn.keys);
      console.log("[touchdeck] menu press", buttonId);
    } catch (err) {
      console.error("[touchdeck] menu press error:", err.message);
    }
  }
  closeMenuWindow();
});

// ===== 键鼠模式（ui.input === "mouse"）：Tab 键展开菜单，松开 Tab 确认悬停项 =====
// focusable:false 窗口收不到键盘事件，用系统级 globalShortcut 注册 Tab；
// Tab 松开（0x8000 位消失）时发送 menu-confirm，由菜单端确认当前悬停扇区或取消
let tabTimer = null;
function registerTabShortcut() {
  ensureWin32();
  const ok = globalShortcut.register("Tab", () => {
    if (resolveConfig().ui.mode !== "bubble" || resolveConfig().ui.input !== "mouse") return;
    if (menuWin && !menuWin.isDestroyed()) {
      // Tab 再次按下：收起（键鼠习惯：Esc/Tab 关菜单）
      closeMenuWindow();
      return;
    }
    openMenuWindow("docked");
    clearInterval(tabTimer);
    tabTimer = setInterval(() => {
      const vk = GetAsyncKeyState ? GetAsyncKeyState(0x09) : 0;
      if (!(vk & 0x8000)) {
        clearInterval(tabTimer);
        tabTimer = null;
        if (menuWin && !menuWin.isDestroyed()) menuWin.webContents.send("menu-confirm");
      }
    }, 50);
  });
  console.log("[touchdeck] Tab shortcut", ok ? "registered" : "FAILED");
}

// ===== 控制台窗口（交互界面：模式切换/面板启停/P2P 连接）+ 面板管理 =====
let consoleWin = null;

const CONSOLE_WIDTH = 560;
const CONSOLE_HEIGHT = 620;

function createConsoleWindow() {
  consoleWin = new BrowserWindow({
    width: CONSOLE_WIDTH, height: CONSOLE_HEIGHT,
    title: "TouchDeck 控制台",
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  console.log("[touchdeck] console window created", JSON.stringify(consoleWin.getBounds()), "visible:", consoleWin.isVisible());
  consoleWin.loadFile(path.join(__dirname, "renderer", "console.html"));
  consoleWin.webContents.on("console-message", (_e, _l, msg) => console.log("[console]", msg));
  // 最小化/关闭都进托盘（常驻，防误关）；托盘「退出」才真正退出
  consoleWin.on("minimize", (e) => {
    e.preventDefault();
    consoleWin.hide();
  });
  consoleWin.on("close", (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      consoleWin.hide();
    }
  });
  consoleWin.on("closed", () => { consoleWin = null; });
}

// 系统托盘：控制台最小化/关闭后驻留，点击恢复；「退出」结束控制台与面板（服务器独立自启不受影响）
let tray = null;
function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(path.join(__dirname, "assets", "tray.png")));
    tray.setToolTip("TouchDeck 控制台");
    const show = () => {
      if (consoleWin && !consoleWin.isDestroyed()) {
        consoleWin.show();
        if (consoleWin.isMinimized()) consoleWin.restore();
        consoleWin.focus();
      }
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示控制台", click: show },
      { type: "separator" },
      { label: "退出 TouchDeck", click: () => app.quit() },
    ]));
    tray.on("click", show);
    console.log("[touchdeck] tray created");
  } catch (err) {
    console.error("[touchdeck] tray create failed:", err.message);
  }
}

// 按配置模式启动/重建面板窗口（grid 或 bubble），已存在则先销毁。
// 用户可在控制台关闭面板（用安卓端时避免 Windows 双悬浮球）；关闭状态持久化到 state
function panelDisabled() {
  const s = loadState();
  return s && s.panel === false;
}

function startPanel() {
  if (panelDisabled()) return;
  closeMenuWindow();
  if (win && !win.isDestroyed()) win.destroy();
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.destroy();
  win = null;
  bubbleWin = null;
  if (resolveConfig().ui.mode === "bubble") {
    createBubbleWindow();
  } else {
    createWindow();
  }
}

function stopPanel() {
  closeMenuWindow();
  if (win && !win.isDestroyed()) win.destroy();
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.destroy();
  win = null;
  bubbleWin = null;
}

function registerConsoleIpc() {
  ipcMain.handle("console-status", async () => {
    const cfg = resolveConfig();
    const panelOn = !panelDisabled() && !!((win && !win.isDestroyed()) || (bubbleWin && !bubbleWin.isDestroyed()));
    return {
      mode: cfg.ui.mode || "grid",
      input: cfg.ui.input || "mouse",
      panelRunning: panelOn,
      panelDisabled: panelDisabled(),
    };
  });

  ipcMain.handle("console-toggle-panel", async () => {
    if (panelDisabled()) {
      // 开启面板：清掉关闭标记并启动
      const s = loadState() || {};
      saveState({ ...s, panel: true });
      startPanel();
    } else {
      stopPanel();
      const s = loadState() || {};
      saveState({ ...s, panel: false });
    }
    return { running: !panelDisabled() && !!((win && !win.isDestroyed()) || (bubbleWin && !bubbleWin.isDestroyed())) };
  });

  ipcMain.handle("console-set-mode", async (_e, mode) => {
    console.log("[touchdeck] console-set-mode", mode);
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (mode === "grid" || mode === "bubble") {
      if (mode === "grid") delete user.ui;
      else user.ui = { ...(user.ui || {}), mode: "bubble" };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(user, null, 2) + "\n");
    }
    startPanel();
    return { ok: true };
  });

  ipcMain.handle("console-set-input", async (_e, input) => {
    console.log("[touchdeck] console-set-input", input);
    const user = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
    if (input === "mouse" || input === "touch") {
      user.ui = { ...(user.ui || {}), input };
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(user, null, 2) + "\n");
    }
    startPanel();
    return { ok: true };
  });

  ipcMain.handle("console-open-panel", () => {
    startPanel();
    return { ok: true };
  });
}

// ===== P2P 中继（隐藏窗口跑 WebRTC，DataChannel 按键 → 本地注入）=====
let peerWin = null;
let peerStatus = { phase: "idle" };

function createPeerWindow() {
  if (peerWin && !peerWin.isDestroyed()) return;
  peerWin = new BrowserWindow({
    width: 1, height: 1, show: false, frame: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true },
  });
  peerWin.loadFile(path.join(__dirname, "renderer", "peer.html"));
  peerWin.webContents.on("console-message", (_e, _l, msg) => console.log("[peer]", msg));
  peerWin.on("closed", () => { peerWin = null; });
}

function registerPeerIpc() {
  ipcMain.on("peer-status", (_e, s) => {
    peerStatus = { ...peerStatus, ...s };
    if (consoleWin && !consoleWin.isDestroyed()) {
      consoleWin.webContents.send("peer-status", peerStatus);
    }
  });
  ipcMain.handle("peer-start", (_e, signalUrl) => {
    createPeerWindow();
    peerStatus = { phase: "connecting" };
    peerWin.webContents.send("peer-start", signalUrl || null);
    return { ok: true };
  });
  ipcMain.handle("peer-stop", () => {
    if (peerWin && !peerWin.isDestroyed()) peerWin.webContents.send("peer-stop");
    peerStatus = { phase: "idle" };
    return { ok: true };
  });
  ipcMain.handle("peer-status-get", () => peerStatus);
  ipcMain.on("peer-press", async (_e, buttonId) => {
    const btn = resolveConfig().buttons.find((b) => b.id === buttonId);
    if (!btn || !btn.keys) return;
    try {
      await sendKeys(btn.keys);
      console.log("[touchdeck] peer press", buttonId);
    } catch (err) {
      console.error("[touchdeck] peer press error:", err.message);
    }
  });
}

// ===== 启动 =====
// 单实例锁：重复启动直接退出，避免桌面快捷方式连点开出两个面板；
// 二次启动（快捷方式再点）时把控制台窗口拉回前台
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (consoleWin && !consoleWin.isDestroyed()) {
      if (consoleWin.isMinimized()) consoleWin.restore();
      consoleWin.show();
      consoleWin.focus();
    }
  });
}

app.whenReady().then(() => {
  registerCommonIpc();
  registerConsoleIpc();
  registerPeerIpc();
  createConsoleWindow();
  createTray();
  registerTabShortcut();
  startPanel(); // 控制台打开时自动按配置启动面板（开箱即用）

  // 系统缩放/分辨率变化：重建面板（球/菜单尺寸位置随新 DPI 校正），防抖 500ms
  let dpiTimer = null;
  screen.on("display-metrics-changed", () => {
    clearTimeout(dpiTimer);
    dpiTimer = setTimeout(() => {
      console.log("[touchdeck] display metrics changed, rebuilding panel");
      closeMenuWindow();
      startPanel();
    }, 500);
  });
});

// 托盘「退出」与真实退出：放行窗口关闭
app.on("before-quit", () => {
  app.isQuitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
