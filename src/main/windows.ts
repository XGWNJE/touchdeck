// ===== 窗口层：悬浮球 / 全屏径向菜单 / 控制台 / 托盘 / 面板启停 / Tab 快捷键 =====
// 2026-08-05 定案：本机唯一面板形态 = 悬浮球（网格模式已移除）；
// 球窗口（小圆球，可拖）+ 全屏透明菜单窗口（展开时创建，收起销毁）。
import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, screen, Tray } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig } from "../shared/config-resolve";
import { ROOT, wins, hwndOf, loadState, saveState, isPositionUsable, clampToWorkArea } from "./state";
import { ensureWin32, GetAsyncKeyState, SetWindowPos } from "./win32";
import { enqueueAction } from "./macro";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "..", "preload", "index.cjs");
// Windows 窗口图标用多尺寸 .ico（16..256）：任务栏按目标尺寸取帧，避免 256px PNG
// 缩放后内容变小/模糊（2026-08-13 修正：原 app-icon.png 内容仅占画布 66%，
// 且单尺寸 PNG 在任务栏缩放过度；现改为内容铺满的 .ico）
const APP_ICON = path.join(ROOT, "src", "assets", "app-icon.ico");
// electron-vite dev 模式走 dev server URL；`electron .` 直跑/打包后走 out/renderer 文件
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;
let bubbleRendererReadyId: number | null = null;
function loadRenderer(win: BrowserWindow, page: string): void {
  if (!app.isPackaged && RENDERER_URL) win.loadURL(`${RENDERER_URL}/${page}/`);
  else win.loadFile(path.join(ROOT, "out", "renderer", page, "index.html"));
}

function bubbleAnchor() {
  if (!wins.bubble || wins.bubble.isDestroyed()) return null;
  // 菜单只画扇区，真实悬浮球是唯一球芯；锚点必须取 Chromium 内容区中心，
  // 不能用可能含 Win32 非客户区/DPI 取整误差的窗口外框中心。
  const b = wins.bubble.getContentBounds();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
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
  bubbleRendererReadyId = null;
  bubbleWin.setAlwaysOnTop(true, "screen-saver");
  bubbleWin.webContents.setVisualZoomLevelLimits(1, 1).catch(() => {});
  loadRenderer(bubbleWin, "bubble");
  bubbleWin.webContents.on("console-message", (_e, _l, msg) => console.log("[bubble]", msg));
  const bubbleContentsId = bubbleWin.webContents.id;
  bubbleWin.on("closed", () => {
    if (bubbleRendererReadyId === bubbleContentsId) bubbleRendererReadyId = null;
  });

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

// 打开全屏透明菜单窗口；anchorOverride 存在时以该点展开，否则以悬浮球内容区中心展开。
// 菜单只画扇区、不再复制球芯：真实悬浮球是唯一视觉来源，从结构上消除跨窗口叠影。
function openMenuWindow(anchorOverride?: { x: number; y: number }): void {
  if (wins.menu && !wins.menu.isDestroyed()) return;
  const globalAnchor = anchorOverride ?? bubbleAnchor();
  if (!globalAnchor) return;
  const b = screen.getDisplayNearestPoint({ x: globalAnchor.x, y: globalAnchor.y }).bounds;
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
    const anchor = anchorOverride ?? bubbleAnchor();
    if (!anchor || !wins.bubble || wins.bubble.isDestroyed()) {
      closeMenuWindow();
      return;
    }
    const bubbleContent = wins.bubble.getContentBounds();
    console.log("[touchdeck] menu window bounds", JSON.stringify(menuWin.getBounds()));
    menuWin.webContents.send("menu-init", {
      anchor: { x: anchor.x - b.x, y: anchor.y - b.y },
      ballSize: Math.max(1, Math.min(bubbleContent.width, bubbleContent.height) - 8),
      screen: { width: b.width, height: b.height },
    });
  });
}

export function closeMenuWindow(): void {
  if (wins.menu && !wins.menu.isDestroyed()) {
    wins.menu.destroy();
  }
  wins.menu = null;
  // 菜单销毁后立即把球拉回置顶层顶部，不等下个轮询周期
  // （菜单窗口与球同为置顶，后创建的菜单会排在球前；收起后球须恢复最上层）
  if (wins.bubble && !wins.bubble.isDestroyed()) {
    wins.bubble.setAlwaysOnTop(true, "screen-saver");
  }
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
  if (globalShortcut.isRegistered("Tab")) return;
  ensureWin32();
  const ok = globalShortcut.register("Tab", () => {
    // 本机面板关闭时 Tab 属于前台应用，绝不能创建无锚点菜单或吞掉用户按键。
    if (panelDisabled() || !wins.bubble || wins.bubble.isDestroyed()) return;
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
const CONSOLE_WIDTH = 760;
const CONSOLE_HEIGHT = 880;

export function createConsoleWindow(): void {
  const consoleWin = new BrowserWindow({
    width: CONSOLE_WIDTH, height: CONSOLE_HEIGHT,
    minWidth: 680, minHeight: 720,
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
  registerTabShortcut();
  startTopmostKeepAlive();
  startXButton2Watch();
  notifyPanelStatus();
}

export function stopPanel(): void {
  stopTopmostKeepAlive();
  stopXButton2Watch();
  globalShortcut.unregister("Tab");
  if (tabTimer) clearInterval(tabTimer);
  tabTimer = null;
  tabHoldActive = false;
  closeMenuWindow();
  if (wins.bubble && !wins.bubble.isDestroyed()) wins.bubble.destroy();
  wins.bubble = null;
  notifyPanelStatus();
}

// ===== 悬浮球保持置顶（2026-08-14）=====
// Windows 置顶语义：置顶窗口按“最近一次成为置顶”排序，其他应用新建置顶/全屏窗口
// 会不断插到悬浮球前面，球的层级持续下跌最终被普通窗口挡住（2026-08-14 实证）。
// setAlwaysOnTop 只在调用时生效，不能维持；面板开启期间必须周期性地把球重新拉回
// 置顶层顶部。菜单展开时不提顶（菜单窗口需接收全屏菜单交互，但透明中心透出真实球）；
// 菜单销毁由 closeMenuWindow 立即提顶一次，这里只兜底常规窗口堆叠。
let topmostTimer: NodeJS.Timeout | null = null;
const TOPMOST_KEEPALIVE_MS = 2000; // 周期：置顶层级下跌是慢过程，2s 足以及时拉回且开销可忽略

function startTopmostKeepAlive(): void {
  if (topmostTimer) return;
  topmostTimer = setInterval(() => {
    if (panelDisabled() || !wins.bubble || wins.bubble.isDestroyed()) return;
    if (wins.menu && !wins.menu.isDestroyed()) return; // 菜单展开中：球应在菜单下方
    wins.bubble.setAlwaysOnTop(true, "screen-saver");
  }, TOPMOST_KEEPALIVE_MS);
}

function stopTopmostKeepAlive(): void {
  if (topmostTimer) {
    clearInterval(topmostTimer);
    topmostTimer = null;
  }
}

// ===== 鼠标侧键展开菜单（2026-08-14，v0.3.2）=====
// 无键盘时用鼠标前进键（XButton2, VK 0x06）展开/收起菜单。触发展开时把悬浮球
// 传送到鼠标当前位置（淡出→移动→淡入），菜单以球中心为锚点展开——球保留在新位置，
// 不再回到原位（2026-08-14 修订：原实现菜单锚点=鼠标但球留在原处并 hide，视觉抖动；
// 现改为移动球本身，锚点恒等于球位置，无 hide 也就无抖动）。
// 轮询 GetAsyncKeyState 检测下降沿（本帧按下且上帧未按下），避免长按/自动重复误触发；
// 只在本机鼠标场景生效（UU 触控注入读不到按键状态，且侧键本就只存在于真实鼠标）。
// 菜单在别处展开（点球/Tab）时侧键同样可收起：语义 = toggle。
let x2Timer: NodeJS.Timeout | null = null;
let x2PrevDown = false;
const XBUTTON2_POLL_MS = 25;
const BUBBLE_FADE_TIMEOUT_MS = 240;
let bubbleFadeSeq = 0;
let bubbleTeleporting = false;
const pendingBubbleFades = new Map<string, {
  senderId: number;
  finish: () => void;
}>();

async function waitForBubbleRenderer(w: BrowserWindow): Promise<boolean> {
  const deadline = Date.now() + 1200;
  while (!w.isDestroyed() && bubbleRendererReadyId !== w.webContents.id && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 16));
  }
  return !w.isDestroyed() && bubbleRendererReadyId === w.webContents.id;
}

// 等渲染端 opacity transitionend 后再继续移动；超时只作兜底，不能再把 CSS 时长当成绘制完成证明。
function waitForBubbleFade(w: BrowserWindow, visible: boolean): Promise<void> {
  if (w.isDestroyed()) return Promise.resolve();
  const contents = w.webContents;
  const requestId = `bubble-fade-${Date.now()}-${++bubbleFadeSeq}`;
  return new Promise((resolve) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const send = () => {
      if (settled || w.isDestroyed()) { finish(); return; }
      pendingBubbleFades.set(requestId, { senderId: contents.id, finish });
      contents.send("bubble-fade", visible, requestId);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      contents.removeListener("did-finish-load", send);
      w.removeListener("closed", finish);
      pendingBubbleFades.delete(requestId);
      resolve();
    };
    timer = setTimeout(() => {
      console.warn("[touchdeck] bubble fade acknowledgement timeout", requestId, visible ? "in" : "out");
      finish();
    }, BUBBLE_FADE_TIMEOUT_MS);
    w.once("closed", finish);
    if (contents.isLoadingMainFrame()) contents.once("did-finish-load", send);
    else send();
  });
}

// 把悬浮球淡出→移动到指定位置→淡入；移动完成回调在渲染端确认淡入结束后触发。
// 移动用 Win32 SetWindowPos（物理像素换算）：透明窗口上 Electron setPosition 移动
// 会残留旧位置伪影（drag.ts 注释已记载），表现为"旧位置留半个球、新位置出现球"
// 的两层观感（2026-08-14 实证）；SetWindowPos 是拖拽已验证的无伪影路径。
async function teleportBubble(x: number, y: number, done?: () => void): Promise<void> {
  const w = wins.bubble;
  if (!w || w.isDestroyed()) { done?.(); return; }
  if (bubbleTeleporting) return;
  bubbleTeleporting = true;
  ensureWin32();
  const hwnd = hwndOf(w);
  const scale = screen.getDisplayNearestPoint({ x, y }).scaleFactor || 1;
  let moved = false;
  try {
    if (!(await waitForBubbleRenderer(w))) throw new Error("bubble renderer not ready");
    await waitForBubbleFade(w, false);
    if (w.isDestroyed()) return;
    const ok = SetWindowPos(hwnd, 0, Math.round(x * scale), Math.round(y * scale), 0, 0, 0x0215);
    if (!ok) throw new Error("SetWindowPos failed");
    saveState({ x, y });                               // 球保留在新位置，重启恢复同位置
    moved = true;
    w.webContents.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 16));
  } catch (err: any) {
    console.error("[touchdeck] bubble teleport failed:", err?.message || String(err));
  } finally {
    if (!w.isDestroyed()) await waitForBubbleFade(w, true);
    bubbleTeleporting = false;
  }
  if (moved) done?.();
}

// 侧键展开的锚点由 openMenuWindow 读取传送后的球内容区中心。

function startXButton2Watch(): void {
  if (x2Timer) return;
  ensureWin32();
  x2Timer = setInterval(() => {
    if (panelDisabled() || !wins.bubble || wins.bubble.isDestroyed()) return;
    const down = !!(GetAsyncKeyState(0x06) & 0x8000);
    const edge = down && !x2PrevDown;
    x2PrevDown = down;
    if (!edge) return;
    if (bubbleTeleporting) return;
    if (wins.menu && !wins.menu.isDestroyed()) {
      // 菜单已展开时再按侧键：看鼠标是否还在球上
      const pt = screen.getCursorScreenPoint();
      const b = wins.bubble.getBounds();
      const onBall = pt.x >= b.x && pt.x <= b.x + b.width && pt.y >= b.y && pt.y <= b.y + b.height;
      if (onBall) {
        closeMenuWindow();   // 鼠标还在球上：直接收起菜单
      } else {
        // 鼠标已移走：收起当前菜单，把球传送到新鼠标位置，以球实际中心为锚点重新展开
        closeMenuWindow();
        const [bw, bh] = wins.bubble.getSize();
        const [tx, ty] = clampToWorkArea(Math.round(pt.x - bw / 2), Math.round(pt.y - bh / 2), bw, bh);
        void teleportBubble(tx, ty, () => openMenuWindow());
      }
      return;
    }
    // 展开：球传送到鼠标位置（夹取在工作区内）后，以球实际中心为锚点展开菜单。
    // 不传 anchorOverride：openMenuWindow 内部用 bubbleAnchor() 读取传送后的内容区，
    // 锚点永远等于球实际内容区中心，菜单中心不再复制第二个球。
    const pt = screen.getCursorScreenPoint();
    const [bw, bh] = wins.bubble.getSize();
    const [tx, ty] = clampToWorkArea(Math.round(pt.x - bw / 2), Math.round(pt.y - bh / 2), bw, bh);
    void teleportBubble(tx, ty, () => openMenuWindow());
  }, XBUTTON2_POLL_MS);
}

function stopXButton2Watch(): void {
  if (x2Timer) {
    clearInterval(x2Timer);
    x2Timer = null;
  }
  x2PrevDown = false;
}

// 菜单开关：必须只注册一次（曾挂在 createBubbleWindow 里，面板每次重建都叠加监听，
// 两次监听把一次 toggle 执行成「开+关」，菜单闪开即收——2026-08-06 热重载触发实证）
export function registerMenuIpc(): void {
  ipcMain.on("bubble-ready", (event) => {
    if (!wins.bubble || wins.bubble.isDestroyed() || event.sender.id !== wins.bubble.webContents.id) return;
    bubbleRendererReadyId = event.sender.id;
  });
  ipcMain.on("bubble-fade-complete", (event, requestId: string) => {
    const pending = pendingBubbleFades.get(requestId);
    if (!pending || pending.senderId !== event.sender.id) return;
    pending.finish();
  });
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
