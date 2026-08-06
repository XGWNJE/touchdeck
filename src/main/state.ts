// 跨模块共享的运行时状态与路径：窗口句柄、前台快照、图标缓存、状态持久化、边界夹取。
// 集中一处持有，避免模块间互传变量造成环形引用。
import { BrowserWindow, screen } from "electron";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { ForegroundInfo } from "../shared/config-resolve";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// out/main/ 上溯两级 = 包根（dev=项目根，打包=asar 根）
export const ROOT = path.join(HERE, "..", "..");
export const CONFIG_PATH = path.join(ROOT, "touchdeck.config.json");
export const STATE_PATH = path.join(ROOT, "touchdeck.state.json");

// 四个窗口句柄：球 / 全屏菜单 / 控制台 / P2P 中继（隐藏）
export const wins: {
  bubble: BrowserWindow | null;
  menu: BrowserWindow | null;
  console: BrowserWindow | null;
  peer: BrowserWindow | null;
} = { bubble: null, menu: null, console: null, peer: null };

// 前台窗口快照（500ms 轮询维护，注入热路径不调 Win32）
export const fgCache: ForegroundInfo = { pid: 0, process: "", title: "" };
// undefined=未初始化；null=默认场景
export const scenarioState: { active: string | null | undefined } = { active: undefined };
// P2P 中继状态（peer-status IPC 合并写入）
export const peerStatusBox: { value: Record<string, unknown> } = { value: { phase: "idle" } };

// 图标缓存壳：解析逻辑在共享模块（scripts/build-panel-assets 同用）。
// 模块级：配置热重载时要整体清空（主题/图标文件可能已变）。
export const iconCache = new Map<string, unknown>();

// 面板位置与启停状态持久化：拖动结束写入，启动时恢复；与面向用户的 config 分离（机器状态不手改）。
// loadState 返回整个状态对象（x/y 可能缺失，调用方用 isPositionUsable 自行判有效性）；
// saveState 合并写——x/y（拖球）与 panel（启停）是两个关注点，覆盖写会互相冲掉（2026-08-05 实证：
// 未拖过球就关面板时旧版 loadState 因缺 x/y 返回 null，panel=false 标记丢失，重启后面板自启）。
export function loadState(): Record<string, any> | null {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
    if (s && typeof s === "object") return s;
  } catch { /* 无状态文件属正常 */ }
  return null;
}

export function saveState(patch: Record<string, unknown>): void {
  try {
    const cur = loadState() || {};
    fs.writeFileSync(STATE_PATH, JSON.stringify({ ...cur, ...patch }));
  } catch (e: any) {
    console.error("[touchdeck] 状态持久化失败:", e.message);
  }
}

// 记忆的窗口位置仍有足够区域落在某块屏幕内才算有效（防拔显示器后窗口飞走）
export function isPositionUsable(x: number, y: number, width: number, height: number): boolean {
  const disp = screen.getDisplayNearestPoint({ x, y });
  const a = disp.workArea;
  const overlapX = Math.min(x + width, a.x + a.width) - Math.max(x, a.x);
  const overlapY = Math.min(y + height, a.y + a.height) - Math.max(y, a.y);
  return overlapX >= 80 && overlapY >= 80;
}

// 拖球边界（2026-08-06）：任何时刻整球在工作区内且与边缘保持 EDGE_MARGIN 极限距离。
// 返回 [夹取后x, 夹取后y, workArea]；逻辑像素（SetWindowPos 前再按 scaleFactor 换算）。
export const EDGE_MARGIN = 12;
export function clampToWorkArea(nx: number, ny: number, w: number, h: number): [number, number, Electron.Rectangle] {
  const a = screen.getDisplayNearestPoint({ x: nx + w / 2, y: ny + h / 2 }).workArea;
  const minX = a.x + EDGE_MARGIN, maxX = Math.max(minX, a.x + a.width - w - EDGE_MARGIN);
  const minY = a.y + EDGE_MARGIN, maxY = Math.max(minY, a.y + a.height - h - EDGE_MARGIN);
  return [Math.min(Math.max(nx, minX), maxX), Math.min(Math.max(ny, minY), maxY), a];
}

export function hwndOf(window: BrowserWindow): number {
  return Number(window.getNativeWindowHandle().readBigUInt64LE(0));
}
