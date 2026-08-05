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

// 面板位置与启停状态持久化：拖动结束写入，启动时恢复；与面向用户的 config 分离（机器状态不手改）。
// loadState 返回整个状态对象（x/y 可能缺失，调用方用 isPositionUsable 自行判有效性）；
// saveState 合并写——x/y（拖球）与 panel（启停）是两个关注点，覆盖写会互相冲掉（2026-08-05 实证：
// 未拖过球就关面板时旧版 loadState 因缺 x/y 返回 null，panel=false 标记丢失，重启后面板自启）。
function loadState() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    if (s && typeof s === "object") return s;
  } catch { /* 无状态文件属正常 */ }
  return null;
}

function saveState(patch) {
  try {
    const cur = loadState() || {};
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...cur, ...patch }));
  } catch (e) {
    console.error("[touchdeck] 状态持久化失败:", e.message);
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
    // 2026-08-05 定案：本机面板只保留悬浮球模式 + 键鼠交互（触控归安卓悬浮球端），
    // 不再读 ui.mode / ui.input 配置
    ui: { mode: "bubble", input: "mouse" },
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

// 通用 IPC：配置/图标/注入/拖拽。
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
  const dragTarget = () => bubbleWin;
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

// ===== 悬浮球面板（2026-08-05 定案：本机唯一面板形态，网格模式已移除）=====
// 球窗口（小圆球，可拖）+ 全屏透明菜单窗口（展开时创建，收起销毁）。
let bubbleWin = null;
let menuWin = null;

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

  ipcMain.on("toggle-menu", () => {
    if (menuWin && !menuWin.isDestroyed()) closeMenuWindow();
    else openMenuWindow();
  });
  ipcMain.on("close-menu", () => closeMenuWindow());

  console.log("[touchdeck] bubble window", JSON.stringify(bubbleWin.getBounds()));
}

function openMenuWindow() {
  if (menuWin && !menuWin.isDestroyed()) return;
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

// ===== 键鼠交互：Tab 键展开菜单，松开 Tab 确认悬停项 =====
// focusable:false 窗口收不到键盘事件，用系统级 globalShortcut 注册 Tab；
// Tab 松开（0x8000 位消失）时发送 menu-confirm，由菜单端确认当前悬停扇区或取消。
// 注意：按住 Tab 时 Windows 键盘自动重复会反复触发 globalShortcut 回调（RegisterHotKey
// 机理），必须以 tabHoldActive 区分「按住期间的重复触发」（忽略）与「松开后的再次按下」
// （收起）——2026-08-05 实证：无守卫时按住 Tab 不松，自动重复触发走到收起分支，
// 菜单在按住期间被误关掉。
let tabTimer = null;
let tabHoldActive = false;
function registerTabShortcut() {
  ensureWin32();
  const ok = globalShortcut.register("Tab", () => {
    if (menuWin && !menuWin.isDestroyed()) {
      if (tabHoldActive) return;   // 本次按住展开期间的自动重复，忽略
      // 常驻菜单（点球展开的）再按 Tab：收起（键鼠习惯：Esc/Tab 关菜单）
      closeMenuWindow();
      return;
    }
    openMenuWindow();
    tabHoldActive = true;
    clearInterval(tabTimer);
    tabTimer = setInterval(() => {
      const vk = GetAsyncKeyState ? GetAsyncKeyState(0x09) : 0;
      if (!(vk & 0x8000)) {
        clearInterval(tabTimer);
        tabTimer = null;
        tabHoldActive = false;
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

// 启动/重建悬浮球面板，已存在则先销毁。
// 用户可在控制台关闭面板（用安卓端时避免 Windows 双悬浮球）；关闭状态持久化到 state
function panelDisabled() {
  const s = loadState();
  return s && s.panel === false;
}

function panelRunning() {
  return !!(bubbleWin && !bubbleWin.isDestroyed());
}

// 面板状态主动推送控制台（启停/DPI 重建后 UI 立即刷新，不等 4s 轮询）
function notifyPanelStatus() {
  if (consoleWin && !consoleWin.isDestroyed()) {
    consoleWin.webContents.send("panel-status", {
      panelRunning: !panelDisabled() && panelRunning(),
      panelDisabled: panelDisabled(),
    });
  }
}

function startPanel() {
  if (panelDisabled()) return;
  closeMenuWindow();
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.destroy();
  bubbleWin = null;
  createBubbleWindow();
  notifyPanelStatus();
}

function stopPanel() {
  closeMenuWindow();
  if (bubbleWin && !bubbleWin.isDestroyed()) bubbleWin.destroy();
  bubbleWin = null;
  notifyPanelStatus();
}

function registerConsoleIpc() {
  ipcMain.handle("console-status", async () => {
    return {
      panelRunning: !panelDisabled() && panelRunning(),
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
    return { running: !panelDisabled() && panelRunning() };
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
    if (!btn || !btn.keys) {
      console.error("[touchdeck] peer press 未配置:", buttonId);
      if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send("peer-press-failed", buttonId);
      return;
    }
    try {
      await sendKeys(btn.keys);
      console.log("[touchdeck] peer press", buttonId);
    } catch (err) {
      console.error("[touchdeck] peer press error:", err.message);
      // 注入失败必须可见（旧版只写日志，控制台无感知）
      if (consoleWin && !consoleWin.isDestroyed()) consoleWin.webContents.send("peer-press-failed", buttonId);
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
