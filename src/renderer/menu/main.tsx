// 径向菜单（Windows 版，复刻安卓 RadialMenuView）：
// 等面积分环（弧长/环厚恒定）+ 逐槽完整可见性检查（放不下顺延外环）+
// C 皮肤（黑透底、发丝线、选中青色发光三描边近似）。键鼠交互：hover 高亮 + 左击/松 Tab 确认。
// React 壳：canvas 全部命令式绘制（ref 持有），状态变化即 draw()，不走 React 重渲染。
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const CYAN = "rgba(34, 211, 238, 1)";

interface MenuSlot { inner: number; outer: number; a0: number; a1: number; item: any; }
interface MenuState { cx: number; cy: number; slots: MenuSlot[]; }
interface InitPayload { anchor: { x: number; y: number }; ballSize?: number; screen: { width: number; height: number }; }

function withAlpha(color: string, alpha: number): string {
  return color.replace(/[\d.]+\)$/, alpha + ")");
}

function Menu() {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stage = stageRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const flash = flashRef.current!;

    let state: MenuState | null = null;   // { cx, cy, slots }
    let pressedIndex = -1;
    const iconCache = new Map<string, HTMLImageElement | null>();
    let flashTimer: ReturnType<typeof setTimeout> | null = null;
    let ballSize = 103;          // 初始球直径（菜单展开时球芯按同尺寸绘制，视觉一致）

    function setSize(w: number, h: number) {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function layoutMenu(anchor: { x: number; y: number }, screen: { width: number; height: number }, buttons: any[], layout: any): MenuState {
      const cx = anchor.x, cy = anchor.y;
      const edgePad = 100;
      const left = cx < edgePad, right = cx > screen.width - edgePad;
      const top = cy < edgePad, bottom = cy > screen.height - edgePad;
      const isCorner = (left || right) && (top || bottom);
      const isEdge = !isCorner && (left || right || top || bottom);
      let start: number, sweep: number;
      if (isCorner && left && top) { start = 0; sweep = 90; }
      else if (isCorner && right && top) { start = 90; sweep = 90; }
      else if (isCorner && right && bottom) { start = 180; sweep = 90; }
      else if (isCorner && left && bottom) { start = 270; sweep = 90; }
      else if (isEdge && left) { start = -90; sweep = 180; }
      else if (isEdge && right) { start = 90; sweep = 180; }
      else if (isEdge && top) { start = 0; sweep = 180; }
      else if (isEdge && bottom) { start = 180; sweep = 180; }
      else { start = -90; sweep = 360; }

      const bub = layout.bubble || {};
      // 内环间隙下限 = 球半径 + 边距：球芯（与初始球同尺寸绘制）不被扇区压住
      const hubGap = Math.max(bub.hubGap ?? 34, ballSize / 2 + 6);
      const ringThick = bub.ringThick ?? 70;
      const arcLen = bub.arcLen ?? 108;
      const sweepRad = sweep * DEG;
      const visMargin = 10;
      const slots: MenuSlot[] = [];
      let ring = 0, idx = 0;
      while (idx < buttons.length && ring < 16) {
        const inner = hubGap + ring * ringThick;
        const outer = inner + ringThick;
        const rMid = (inner + outer) / 2;
        const nominal = Math.max(1, Math.round((sweepRad * rMid) / arcLen));
        const per = sweep / nominal;
        let usable = 0;
        for (let s = 0; s < nominal; s++) {
          if (idx >= buttons.length) break;
          const a0 = start + per * s, a1 = a0 + per;
          if (slotButtonVisible(cx, cy, inner, outer, a0, a1, screen, visMargin)) {
            slots.push({ inner, outer, a0, a1, item: buttons[idx] });
            idx++; usable++;
          }
        }
        // 锚点贴角/出屏时首环可能整环不可见，外环反而伸得回屏内——
        // 只有内径超过屏幕对角线（任何点都不可能可见）才真的没空间
        if (usable === 0 && inner > Math.hypot(screen.width, screen.height)) break;
        ring++;
      }
      // 排不下的按钮必须显形：宁可加外环也不裁按钮；仍有丢弃（16 环硬上限）时日志告警
      if (slots.length < buttons.length) {
        console.warn(`menu layout DROPPED: placed ${slots.length}/${buttons.length}, anchor=(${cx},${cy})`);
      } else {
        console.log(`menu layout slots=${slots.length}/${buttons.length} rings=${ring + 1} anchor=(${cx},${cy})`);
      }
      return { cx, cy, slots };
    }

    // 按钮完整可见判定：按钮内容区（图标盒 + 文字盒，中角方向）完整落在屏内（含 margin）才可落位。
    // 不查扇区角尖——贴角锚点楔形角尖必然越界，全扇区检查会把首环整环卡死（2026-08-05 实测）。
    // 被挡槽位跳过、按钮顺延外环。
    function slotButtonVisible(cx: number, cy: number, inner: number, outer: number, a0: number, a1: number, screen: { width: number; height: number }, m: number): boolean {
      const mid = ((a0 + a1) / 2) * DEG;
      const thick = outer - inner;
      const half = 18; // 图标 24px/2 + 余量；文字盒近似同量级
      const dirX = Math.cos(mid), dirY = Math.sin(mid);
      for (const r of [inner + thick * 0.38, inner + thick * 0.76]) {
        const px = cx + r * dirX, py = cy + r * dirY;
        if (px - half < m || px + half > screen.width - m || py - half < m || py + half > screen.height - m) return false;
      }
      return true;
    }

    function hit(x: number, y: number): number {
      if (!state) return -1;
      const dx = x - state.cx, dy = y - state.cy;
      const dist = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx) / DEG;
      for (let i = 0; i < state.slots.length; i++) {
        const s = state.slots[i];
        if (dist < s.inner || dist > s.outer) continue;
        let rel = ang - s.a0;
        while (rel < 0) rel += 360;
        while (rel >= 360) rel -= 360;
        if (rel <= s.a1 - s.a0) return i;
      }
      return -1;
    }

    function draw() {
      if (!state) return;
      const { cx, cy, slots } = state;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.save();
      ctx.translate(cx, cy);

      // 球芯：与初始球同尺寸（白球渐变 + 阴影），菜单展开时视觉一致。
      // 覆盖菜单窗口下被环遮挡的球，避免"球变小"的观感。
      const r = ballSize / 2;
      ctx.shadowColor = "rgba(0,0,0,0.35)";
      ctx.shadowBlur = 8;
      const g = ctx.createRadialGradient(-r * 0.3, -r * 0.35, r * 0.15, 0, 0, r);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(1, "#c8c8ce");
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, TAU);
      ctx.fillStyle = g;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.shadowColor = "transparent";
      ctx.strokeStyle = "rgba(0,0,0,0.25)";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        const a0 = s.a0, a1 = s.a1;
        const pressed = i === pressedIndex;
        const path = new Path2D();
        path.arc(0, 0, s.outer, a0 * DEG, a1 * DEG);
        path.arc(0, 0, s.inner, a1 * DEG, a0 * DEG, true);
        path.closePath();

        ctx.fillStyle = "rgba(0,0,0,0.65)";          // 黑透底：只压暗菜单自身区域
        ctx.fill(path);
        if (pressed) { ctx.fillStyle = withAlpha(CYAN, 0.45); ctx.fill(path); }

        ctx.strokeStyle = "rgba(255,255,255,0.35)";  // 发丝分割线
        ctx.lineWidth = 0.7;
        ctx.stroke(path);

        if (pressed) {                                // 青色发光外弧：递宽递淡三描边
          for (const [w, a] of [[9, 0.14], [4.5, 0.35], [2, 1]]) {
            ctx.strokeStyle = withAlpha(CYAN, a);
            ctx.lineWidth = w;
            ctx.beginPath();
            ctx.arc(0, 0, s.outer, a0 * DEG, a1 * DEG);
            ctx.stroke();
          }
        }

        const mid = ((a0 + a1) / 2) * DEG;
        const dirX = Math.cos(mid), dirY = Math.sin(mid);
        const thick = s.outer - s.inner;
        const rIcon = s.inner + thick * 0.38;
        const rLabel = s.inner + thick * 0.76;
        const img = iconCache.get(s.item.icon);
        if (img) {
          const size = 24;
          ctx.drawImage(img, dirX * rIcon - size / 2, dirY * rIcon - size / 2, size, size);
        }
        ctx.fillStyle = s.item.aux ? "#67e8f9" : "#eeeeee";  // aux 常驻键：淡青标签与普通键区分
        ctx.font = "11px 'Microsoft YaHei', sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(s.item.label, dirX * rLabel, dirY * rLabel + 4);
      }
      ctx.restore();
    }

    function flashLabel(text: string) {
      flash.textContent = text;
      flash.classList.add("show");
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => flash.classList.remove("show"), 900);
    }

    // ---- 键鼠交互：hover 待选中 + 左击确认；或按住 Tab 展开、松开 Tab 确认悬停项 ----
    function confirmAt(x: number, y: number) {
      const i = hit(x, y);
      if (i >= 0) {
        const item = state!.slots[i].item;
        window.touchdeck.select(item.id);   // 主进程注入 + 收起；本端 flash 反馈
        flashLabel("发送：" + item.label);
      } else {
        window.touchdeck.dismiss();
      }
      pressedIndex = -1; draw();
    }

    const onPointerDown = (e: PointerEvent) => {
      const i = hit(e.screenX, e.screenY);
      if (i !== pressedIndex) { pressedIndex = i; draw(); }
    };
    const onPointerMove = (e: PointerEvent) => {
      // 悬停也更新高亮（键鼠模式 hover 待选中；按下时由 pressedIndex 驱动，两模式通用）
      const i = hit(e.screenX, e.screenY);
      if (i !== pressedIndex) { pressedIndex = i; draw(); }
    };
    const onPointerUp = (e: PointerEvent) => {
      confirmAt(e.screenX, e.screenY);
    };
    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);

    // ---- 键鼠模式：松开 Tab 确认当前悬停项（Tab 按住展开菜单，松开=确认）----
    window.touchdeck.onMenuConfirm(() => {
      if (pressedIndex >= 0 && state) {
        const item = state.slots[pressedIndex].item;
        window.touchdeck.select(item.id);
        flashLabel("发送：" + item.label);
        pressedIndex = -1; draw();
      } else {
        window.touchdeck.dismiss();
      }
    });

    async function loadIcon(name: string) {
      if (iconCache.has(name)) return;
      iconCache.set(name, null);  // 占位防重复请求
      try {
        const res = await window.touchdeck.getIcon(name);
        if (!res) return;
        const src = res.kind === "svg"
          ? "data:image/svg+xml;utf8," + encodeURIComponent(res.data)
          : res.data;
        await new Promise<void>((resolve, reject) => {
          const img = new Image();
          img.onload = () => { iconCache.set(name, img); resolve(); };
          img.onerror = reject;
          img.src = src;
        });
      } catch { /* 保持 null（文字回退） */ }
      draw();
    }

    // 菜单内容 = 主进程下发的有效按钮集（aux 常驻键占内环起始槽位 + 场景按钮）。
    // 场景切换时主进程发 menu-reload，整组重排。
    let lastInit: InitPayload | null = null;
    async function buildMenu(init: InitPayload) {
      const { anchor, ballSize: bs, screen } = init;
      if (bs) ballSize = bs;
      const config = await window.touchdeck.getConfig();
      const buttons = config.effectiveButtons || config.buttons;
      const layout = config.effectiveLayout || config.layout;
      state = layoutMenu(anchor, screen, buttons, layout);
      setSize(screen.width, screen.height);
      stage.style.setProperty("--px", anchor.x + "px");
      stage.style.setProperty("--py", anchor.y + "px");
      requestAnimationFrame(() => stage.classList.add("open"));

      for (const s of state.slots) loadIcon(s.item.icon);
      draw();
    }

    window.touchdeck.onMenuInit((init) => {
      lastInit = init;
      buildMenu(init);
    });

    // 场景切换：按新按钮集重排（锚点/屏幕不变）
    window.touchdeck.onMenuReload(() => {
      if (lastInit) buildMenu(lastInit);
    });

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  return (
    <>
      <div id="stage" ref={stageRef}><canvas id="cv" ref={canvasRef}></canvas></div>
      <div id="flash" ref={flashRef}></div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Menu />);
