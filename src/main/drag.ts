// ===== 拖球：渲染端长按抓起后，主进程轮询光标用 Win32 SetWindowPos 移动 =====
// （Electron setPosition 走 Chromium 窗口路径，透明窗上高频调用会累积缩放伪影；
//  Modal 移动循环 WM_NCLBUTTONDOWN/SC_MOVE 在 focusable:false 窗口上无效，均不可走）
// SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE|SWP_NOOWNERZORDER = 0x0215
// （误用 0x0233 会带上 SWP_NOMOVE(0x0002)：调用返回成功但位置永远不变——2026-08-02 实证）
// ===== 拖球边界与吸附（2026-08-06）=====
// 拖动全程夹取在工作区内（逻辑像素）；松手按阈值吸附：距边 ≤64px 才吸该边，
// 四边独立判定、邻边同入阈即吸角，吸附后与边缘保持 EDGE_MARGIN 极限距离。
import { ipcMain, screen } from "electron";
import { wins, hwndOf, clampToWorkArea, saveState, EDGE_MARGIN } from "./state";
import { ensureWin32, ReleaseCapture, SetWindowPos, GetAsyncKeyState } from "./win32";

export function registerDragIpc(): void {
  let dragTimer: NodeJS.Timeout | null = null;
  let snapAnim: NodeJS.Timeout | null = null; // 吸附动画句柄：新拖拽/新收尾必须掐断旧动画，否则两套 SetWindowPos 打架

  const endDrag = (tag: string) => {
    if (!dragTimer) return;
    clearInterval(dragTimer);
    dragTimer = null;
    if (snapAnim) clearInterval(snapAnim);
    snapAnim = null;
    const w = wins.bubble;
    if (!w) return;
    // 渲染端 pointerup 常被 SetWindowPos 打断丢失，armed 视觉由主进程通知兜底复位
    if (!w.isDestroyed()) w.webContents.send("drag-ended");
    const [ex, ey] = w.getPosition();
    const [bw, bh] = w.getSize();
    const [cx, cy, area] = clampToWorkArea(ex, ey, bw, bh);
    // 吸附（2026-08-06 修订）：松手位置距某边 ≤ SNAP_THRESHOLD 才吸该边，否则停原位。
    // 两轴独立判定——邻边同时入阈即四角吸附（如左上 = 吸左 + 吸顶），吸后边距 EDGE_MARGIN。
    const SNAP_THRESHOLD = 64;
    let tx = cx, ty = cy;
    const dl = ex - area.x, dr = area.x + area.width - (ex + bw);
    const dt = ey - area.y, db = area.y + area.height - (ey + bh);
    if (Math.min(dl, dr) <= SNAP_THRESHOLD) tx = dl <= dr ? area.x + EDGE_MARGIN : area.x + area.width - bw - EDGE_MARGIN;
    if (Math.min(dt, db) <= SNAP_THRESHOLD) ty = dt <= db ? area.y + EDGE_MARGIN : area.y + area.height - bh - EDGE_MARGIN;
    // ~140ms 缓动滑到边缘（SetWindowPos 物理像素，按目标显示器缩放换算）
    const scale = screen.getDisplayNearestPoint({ x: tx, y: ty }).scaleFactor || 1;
    const hwnd = hwndOf(w);
    const t0 = Date.now();
    snapAnim = setInterval(() => {
      if (w.isDestroyed()) { if (snapAnim) clearInterval(snapAnim); snapAnim = null; return; }
      const k = Math.min(1, (Date.now() - t0) / 140);
      const e = 1 - Math.pow(1 - k, 2);
      const px = Math.round(ex + (tx - ex) * e), py = Math.round(ey + (ty - ey) * e);
      SetWindowPos(hwnd, 0, Math.round(px * scale), Math.round(py * scale), 0, 0, 0x0215);
      if (k >= 1) {
        if (snapAnim) clearInterval(snapAnim);
        snapAnim = null;
        saveState({ x: tx, y: ty }); // 持久化吸附后的位置（重启恢复不越界）
        console.log("[touchdeck] drag end" + tag, "snap ->", JSON.stringify([tx, ty]));
      }
    }, 16);
  };

  ipcMain.on("start-drag", () => {
    const w = wins.bubble;
    if (!w) return;
    if (snapAnim) clearInterval(snapAnim); // 掐断进行中的吸附动画，防与拖拽 SetWindowPos 互相覆盖
    snapAnim = null;
    ensureWin32();
    ReleaseCapture();
    const hwnd = hwndOf(w);
    const startCursor = screen.getCursorScreenPoint();
    const [wx, wy] = w.getPosition();
    const [bw, bh] = w.getSize();
    let lastX = wx, lastY = wy;
    let dbgTick = 0; // 临时诊断：覆盖整个移动阶段，含 winpos 与 SetWindowPos 返回值
    let stillTicks = 0; // 静止计时：光标 ~800ms 无移动自动收尾（松手信号丢失时防拖拽僵死）
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = setInterval(() => {
      try {
        // 松手检测（兜底①：pointerup 被 SetWindowPos 中断时）：
        // 本地鼠标场景左键抬起立即收尾；UU 触控注入读不到按键状态（已知边界），
        // 由 idle 兜底收尾
        const vk = GetAsyncKeyState(0x01);
        if (!(vk & 0x8000)) { endDrag(" (key-up)"); return; }
        const pt = screen.getCursorScreenPoint();
        // 拖动全程夹取在工作区内（含边缘极限距离）：球不越屏，松手再吸附
        const [nx, ny] = clampToWorkArea(
          Math.round(wx + pt.x - startCursor.x),
          Math.round(wy + pt.y - startCursor.y),
          bw, bh
        );
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
      } catch (err: any) {
        console.error("[touchdeck] drag tick error:", err && err.message ? err.message : String(err));
      }
    }, 16);
    console.log("[touchdeck] drag start", JSON.stringify([wx, wy]));
  });

  // 结束拖拽的唯一信号：渲染端松手（pointerup）或下一次按下兜底。
  // UU 触控注入下 GetAsyncKeyState 读不到按键状态（2026-08-02 实测），不能用它判松手
  ipcMain.on("stop-drag", () => { console.log("[touchdeck] stop-drag received, timer running:", !!dragTimer); endDrag(" (stop-drag)"); });
}
