// ===== 窗口层：悬浮球 / 全屏径向菜单 / 控制台 / 托盘 / 面板启停 / Tab 快捷键 =====
// 2026-08-05 定案：本机唯一面板形态 = 悬浮球（网格模式已移除）；
// 球窗口（小圆球，可拖）+ 全屏透明菜单窗口（展开时创建，收起销毁）。
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../shared/config-resolve";
import { ROOT, wins, loadState, saveState, isPositionUsable, clampToWorkArea } from "./state";
import { ensureWin32, GetAsyncKeyState } from "./win32";
import { enqueueAction } from "./macro";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "..", "preload", "index.cjs");
const APP_ICON = path.join(ROOT, "src", "assets", "app-icon.png");
// electron-vite dev 模式走 dev server URL；`electron .` 直跑/打包后走 out/renderer 文件
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
function loadRenderer(win: BrowserWindow, page: string): void {
  if (!app.isPackaged && RENDERER_URL) win.loadURL(`${RENDERER_URL}/${page}/`);
  else win.loadFile(path.join(ROOT, "out", "renderer", page, "index.html"));
}

function bubbleAnchor() {
  const b = wins.bubble!.getBounds();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}

function createBubbleWindow(): void {
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
  // 启动也走边界夹取：记忆位置合法但贴边过近（或 DPI/分辨率变过）时拉回极限距离内
  [x, y] = clampToWorkArea(x, y, ballSize, ballSize);

  const bubbleWin = new BrowserWindow({
    width: ballSize, height: ballSize, x, y,
    icon: APP_ICON,
    frame: false, transparent: true, alwaysOnTop: true,
    focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  wins.bubble = bubbleWin;
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  bubbleWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  loadRenderer(bubbleWin, "bubble");
  bubbleWin.webContents.on("console-message", (_e, _l, msg) => console.log("[bubble]", msg));

  // 拖球结束后持久化位置（SetWindowPos 轮询移动未必触发 moved 事件，stop-drag 里已兜底）
  let moveSaveTimer: NodeJS.Timeout | null = null;
  bubbleWin.on("moved", () => {
    if (moveSaveTimer) clearTimeout(moveSaveTimer);
    moveSaveTimer = setTimeout(() => {
      const [mx, my] = bubbleWin.getPosition();
      saveState({ x: mx, y: my });
    }, 300);
  });

  console.log("[touchdeck] bubble window", JSON.stringify(bubbleWin.getBounds()));
}

function openMenuWindow(): void {
  if (wins.menu && !wins.menu.isDestroyed()) return;
  const b = screen.getPrimaryDisplay().bounds;
  const menuWin = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    icon: APP_ICON,
    frame: false, transparent: true, alwaysOnTop: true,
    focusable: false, skipTaskbar: true, resizable: false, hasShadow: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  wins.menu = menuWin;
  menuWin.setAlwaysOnTop(true, "screen-saver");
  loadRenderer(menuWin, "menu");
  menuWin.webContents.on("console-message", (_e, _l, msg) => console.log("[menu]", msg));
  menuWin.webContents.once("did-finish-load", () => {
    console.log("[touchdeck] menu window bounds", JSON.stringify(menuWin.getBounds()));
    menuWin.webContents.send("menu-init", {
      anchor: bubbleAnchor(),
      ballSize: wins.bubble!.getBounds().width,
      screen: { width: b.width, height: b.height },
    });
  });
}

export function closeMenuWindow(): void {
  if (wins.menu && !wins.menu.isDestroyed()) {
    wins.menu.destroy();
  }
  wins.menu = null;
}

// ===== 键鼠交互：Tab 键展开菜单，松开 Tab 确认悬停项 =====
// focusable:false 窗口收不到键盘事件，用系统级 globalShortcut 注册 Tab；
// Tab 松开（0x8000 位消失）时发送 menu-confirm，由菜单端确认当前悬停扇区或取消。
// 注意：按住 Tab 时 Windows 键盘自动重复会反复触发 globalShortcut 回调（RegisterHotKey
// 机理），必须以 tabHoldActive 区分「按住期间的重复触发」（忽略）与「松开后的再次按下」
// （收起）——2026-08-05 实证：无守卫时按住 Tab 不松，自动重复触发走到收起分支，
// 菜单在按住期间被误关掉。
let tabTimer: NodeJS.Timeout | null = null;
let tabHoldActive = false;
export function registerTabShortcut(): void {
  ensureWin32();
  const ok = globalShortcut.register("Tab", () => {
    if (wins.menu && !wins.menu.isDestroyed()) {
      if (tabHoldActive) return;   // 本次按住展开期间的自动重复，忽略
      // 常驻菜单（点球展开的）再按 Tab：收起（键鼠习惯：Esc/Tab 关菜单）
      closeMenuWindow();
      return;
    }
    openMenuWindow();
    tabHoldActive = true;
    if (tabTimer) clearInterval(tabTimer);
    tabTimer = setInterval(() => {
      const vk = GetAsyncKeyState ? GetAsyncKeyState(0x09) : 0;
      if (!(vk & 0x8000)) {
        if (tabTimer) clearInterval(tabTimer);
        tabTimer = null;
        tabHoldActive = false;
        if (wins.menu && !wins.menu.isDestroyed()) wins.menu.webContents.send("menu-confirm");
      }
    }, 50);
  });
  console.log("[touchdeck] Tab shortcut", ok ? "registered" : "FAILED");
}

// ===== 控制台窗口（交互界面：面板启停/P2P 连接）+ 面板管理 =====
const CONSOLE_WIDTH = 560;
const CONSOLE_HEIGHT = 620;

export function createConsoleWindow(): void {
  const consoleWin = new BrowserWindow({
    width: CONSOLE_WIDTH, height: CONSOLE_HEIGHT,
    title: "TouchDeck 控制台",
    icon: APP_ICON,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  wins.console = consoleWin;
  console.log("[touchdeck] console window created", JSON.stringify(consoleWin.getBounds()), "visible:", consoleWin.isVisible());
  loadRenderer(consoleWin, "console");
  consoleWin.webContents.on("console-message", (_e, _l, msg) => console.log("[console]", msg));
  // 最小化/关闭都进托盘（常驻，防误关）；托盘「退出」才真正退出
  // Electron 类型声明把 minimize 回调标成无参，运行时实传 event（preventDefault 拦截进托盘全靠它）
  (consoleWin as any).on("minimize", (e: Electron.Event) => {
    e.preventDefault();
    consoleWin.hide();
  });
  consoleWin.on("close", (e: Electron.Event) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      consoleWin.hide();
    }
  });
  consoleWin.on("closed", () => { wins.console = null; });
}

// 系统托盘：控制台最小化/关闭后驻留，点击恢复；「退出」结束控制台与面板（服务器独立自启不受影响）
export function createTray(): void {
  try {
    const trayIcon = nativeImage.createFromPath(path.join(ROOT, "src", "assets", "tray.png"));
    const tray: Tray = new Tray(trayIcon);
    tray.setToolTip("TouchDeck 控制台");
    const show = () => {
      if (wins.console && !wins.console.isDestroyed()) {
        wins.console.show();
        if (wins.console.isMinimized()) wins.console.restore();
        wins.console.focus();
      }
    };
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: "显示控制台", click: show },
      { type: "separator" },
      { label: "退出 TouchDeck", click: () => app.quit() },
    ]));
    tray.on("click", show);
    console.log("[touchdeck] tray created");
  } catch (err: any) {
    console.error("[touchdeck] tray create failed:", err.message);
  }
}

// 启动/重建悬浮球面板，已存在则先销毁。
// 用户可在控制台关闭面板（用安卓端时避免 Windows 双悬浮球）；关闭状态持久化到 state
export function panelDisabled(): boolean {
  const s = loadState();
  return !!(s && s.panel === false);
}

export function panelRunning(): boolean {
  return !!(wins.bubble && !wins.bubble.isDestroyed());
}

// 面板状态主动推送控制台（启停/DPI 重建后 UI 立即刷新，不等 4s 轮询）
export function notifyPanelStatus(): void {
  if (wins.console && !wins.console.isDestroyed()) {
    wins.console.webContents.send("panel-status", {
      panelRunning: !panelDisabled() && panelRunning(),
      panelDisabled: panelDisabled(),
    });
  }
}

export function startPanel(): void {
  if (panelDisabled()) return;
  closeMenuWindow();
  if (wins.bubble && !wins.bubble.isDestroyed()) wins.bubble.destroy();
  wins.bubble = null;
  createBubbleWindow();
  notifyPanelStatus();
}

export function stopPanel(): void {
  closeMenuWindow();
  if (wins.bubble && !wins.bubble.isDestroyed()) wins.bubble.destroy();
  wins.bubble = null;
  notifyPanelStatus();
}

// 菜单开关：必须只注册一次（曾挂在 createBubbleWindow 里，面板每次重建都叠加监听，
// 两次监听把一次 toggle 执行成「开+关」，菜单闪开即收——2026-08-06 热重载触发实证）
export function registerMenuIpc(): void {
  ipcMain.on("toggle-menu", () => {
    if (wins.menu && !wins.menu.isDestroyed()) closeMenuWindow();
    else openMenuWindow();
  });
  ipcMain.on("close-menu", () => closeMenuWindow());
  ipcMain.on("menu-select", (_e, buttonId: string) => {
    const r = enqueueAction(buttonId, "menu");
    if (r.ok) console.log("[touchdeck] menu press", buttonId);
    closeMenuWindow();
  });
}
