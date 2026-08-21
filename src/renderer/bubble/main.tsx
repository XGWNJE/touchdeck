// 悬浮球（Windows 版，2026-08-05 定案：本机只保留键鼠交互，触控滑选归安卓端）。
// 手势：快速点按=展开/收起常驻菜单（悬停与确认在菜单端：hover 待选中，
// 左击或松 Tab 确认）；长按 350ms=拖球挪位。无滑选手势。
// 长按反馈（2026-08-06）：按下即起进度环（rAF 驱动 --p 与 HOLD_MS 同步走满），
// 350ms 到点进 armed——球提亮 + 内描边 + 环常亮，松手/取消即复位。
// React 壳：高频 pointer 事件全走 ref + body.classList（与 CSS 选择器契约一致，零重渲染）。
import React, { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";

const HOLD_MS = 350;      // 长按进拖球
const RING_C = 2 * Math.PI * 48;   // SVG 环周长（viewBox 100，r=48）≈ 301.6

function Bubble() {
  const ringRef = useRef<SVGSVGElement>(null);
  // pressed：悬停 pointermove 也会触发（Chromium 兼容事件），必须按下后才响应
  const st = useRef({ pressed: false, dragging: false, holdTimer: null as ReturnType<typeof setTimeout> | null, holdRaf: 0 as number | null });

  useEffect(() => {
    const body = document.body;
    const ring = ringRef.current!;
    const ringProg = ring.querySelector<SVGCircleElement>("#ringProg")!;
    const s = st.current;

    const clearHold = () => {
      if (s.holdTimer) { clearTimeout(s.holdTimer); s.holdTimer = null; }
      if (s.holdRaf) { cancelAnimationFrame(s.holdRaf); s.holdRaf = null; }
      ringProg.style.strokeDashoffset = String(RING_C);   // 进度清零
      body.classList.remove("holding");
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;   // 只响应主键；中键由主进程轮询处理，不触发球按压
      s.pressed = true;
      s.dragging = false;
      body.classList.add("pressed");
      clearHold();
      body.classList.add("holding");
      const t0 = performance.now();
      const tick = (t: number) => {
        // 进度环与长按计时同源同步：视觉上走满 ≈ 拖球待命
        const p = Math.min(1, (t - t0) / HOLD_MS);
        ringProg.style.strokeDashoffset = String(RING_C * (1 - p));
        s.holdRaf = requestAnimationFrame(tick);
      };
      s.holdRaf = requestAnimationFrame(tick);
      s.holdTimer = setTimeout(() => {
        s.holdTimer = null;
        if (s.holdRaf) { cancelAnimationFrame(s.holdRaf); s.holdRaf = null; }
        ringProg.style.strokeDashoffset = "0";            // armed 整环常亮
        s.dragging = true;
        body.classList.remove("pressed", "holding");
        body.classList.add("armed");
        window.touchdeck.startDrag();       // 主进程 SetWindowPos 轮询拖动
      }, HOLD_MS);
      e.preventDefault();
    };

    const onPointerUp = () => {
      if (!s.pressed) return;               // 杂散 up（合成 mouseup 等）不得触发收起/展开
      body.classList.remove("pressed", "armed");
      s.pressed = false;
      clearHold();
      if (s.dragging) {
        window.touchdeck.stopDrag();        // 拖球松手：唯一可信的收尾信号
      } else {
        window.touchdeck.toggleMenu();      // 快速点按：展开/收起常驻菜单
      }
      s.dragging = false;
    };

    const onPointerCancel = () => {
      body.classList.remove("pressed", "armed");
      s.pressed = false;
      clearHold();
      s.dragging = false;
    };

    const ball = document.getElementById("ball")!;
    ball.addEventListener("pointerdown", onPointerDown);
    ball.addEventListener("pointerup", onPointerUp);
    ball.addEventListener("pointercancel", onPointerCancel);

    // 主进程拖拽收尾兜底通知：SetWindowPos 会打断渲染端 pointer capture（pointerup 丢失），
    // 真实拖动松手后由它来复位 armed 视觉（2026-08-06 实证：否则拖拽态一直挂着）
    window.touchdeck.onDragEnded(() => {
      body.classList.remove("pressed", "armed", "holding");
      s.pressed = false;
      clearHold();
      s.dragging = false;
    });

    // 中键传送淡入淡出：以 opacity transitionend 回执主进程，避免固定定时器早于 DWM 绘制提交。
    window.touchdeck.onBubbleFade((visible: boolean, requestId: string) => {
      const wantsFading = !visible;
      const alreadyThere = body.classList.contains("fading") === wantsFading;
      let settled = false;
      let fallback: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (fallback) clearTimeout(fallback);
        ball.removeEventListener("transitionend", onTransitionEnd);
        window.touchdeck.bubbleFadeComplete(requestId);
      };
      const onTransitionEnd = (event: TransitionEvent) => {
        if (event.target === ball && event.propertyName === "opacity") finish();
      };
      ball.addEventListener("transitionend", onTransitionEnd);
      body.classList.toggle("fading", wantsFading);
      if (visible) {
        body.classList.remove("pressed", "armed", "holding");
        s.pressed = false;
        clearHold();
        s.dragging = false;
      }
      if (alreadyThere) requestAnimationFrame(() => requestAnimationFrame(finish));
      else fallback = setTimeout(finish, 180);
    });
    window.touchdeck.bubbleReady();

    return () => {
      ball.removeEventListener("pointerdown", onPointerDown);
      ball.removeEventListener("pointerup", onPointerUp);
      ball.removeEventListener("pointercancel", onPointerCancel);
    };
  }, []);

  return (
    <>
      <div id="ball"></div>
      <svg id="ring" ref={ringRef} viewBox="0 0 100 100">
        <circle id="ringTrack" cx="50" cy="50" r="48"></circle>
        <circle id="ringProg" cx="50" cy="50" r="48"></circle>
      </svg>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Bubble />);
