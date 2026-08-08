// ===== 前台窗口探测 + 场景切换（目标绑定的判定依据）=====
// 面板窗口 focusable:false，GetForegroundWindow 始终指向目标应用；
// 500ms 轮询缓存，触发校验与场景切换都用缓存值，不在注入热路径上调 Win32。
import {
  resolveConfig, resolveScenario, effectiveButtons,
  type PanelButton, type ResolvedConfig,
} from "../shared/config-resolve";
import { wins, fgCache, scenarioState } from "./state";
import {
  ensureWin32, GetForegroundWindow, GetWindowTextW, GetWindowThreadProcessId,
  OpenProcess, QueryFullProcessImageNameW, CloseHandle,
} from "./win32";

export function pollForeground(): void {
  const fg = inspectForeground();
  if (!fg) return;
  if (fgCache.process !== fg.process || fgCache.title !== fg.title) {
    Object.assign(fgCache, fg);
    console.log("[touchdeck] 前台变化:", fg.process, "|", fg.title.slice(0, 40));
    onForegroundChange();
  }
}

// 注入前使用实时探测，不能让一次探测异常沿用旧缓存而误打进别的窗口。
export function inspectForeground(): { pid: number; process: string; title: string } | null {
  try {
    ensureWin32();
    const hwnd = GetForegroundWindow();
    if (!hwnd) return null;
    const tbuf = new Uint16Array(512);
    const tn = GetWindowTextW(hwnd, tbuf, tbuf.length);
    const title = String.fromCharCode(...tbuf.slice(0, tn));
    const pidArr = new Uint32Array(1);
    GetWindowThreadProcessId(hwnd, pidArr);
    const pid = pidArr[0];
    let process = "";
    const h = OpenProcess(0x1000, false, pid);
    if (h) {
      const pbuf = new Uint16Array(512);
      const sz = new Uint32Array([pbuf.length]);
      if (QueryFullProcessImageNameW(h, 0, pbuf, sz)) {
        process = String.fromCharCode(...pbuf.slice(0, sz[0])).split(/[\\/]/).pop() || "";
      }
      CloseHandle(h);
    }
    // 无法取得进程名也不能作为带 target 的安全依据。
    if (!process) return null;
    return { pid, process, title };
  } catch (e: any) {
    console.error("[touchdeck] 前台探测失败:", e.message);
    return null;
  }
}

export interface Effective {
  config: ResolvedConfig;
  scenario: string | null;
  layout: any;
  buttons: PanelButton[];
}

// 当前有效按钮集/布局（aux 常驻 + 场景）；菜单渲染与动作分发共用同一份
export function currentEffective(): Effective {
  const config = resolveConfig();
  const sc = resolveScenario(config, fgCache);
  return {
    config,
    scenario: sc.name,
    layout: sc.layout,
    buttons: effectiveButtons(config, sc.buttons),
  };
}

function onForegroundChange(): void {
  const eff = currentEffective();
  if (eff.scenario === scenarioState.active) return;
  scenarioState.active = eff.scenario;
  console.log("[touchdeck] 场景切换:", scenarioState.active || "默认", "前台:", fgCache.process);
  if (wins.menu && !wins.menu.isDestroyed()) wins.menu.webContents.send("menu-reload");
  if (wins.console && !wins.console.isDestroyed()) {
    wins.console.webContents.send("scenario-changed", { scenario: scenarioState.active, foreground: fgCache.process });
  }
  broadcastButtons();
}

// host→client 按钮集推送：设备上线或场景切换时经 DataChannel 下发，
// 安卓端动态重渲染（离线 panel.json 仅是未连接时的兜底）
function publicButton(b: PanelButton) {
  return { id: b.id, icon: b.icon, label: b.label, sub: b.sub, group: b.group || "edit", confirm: !!b.confirm, aux: !!b.aux };
}

export function broadcastButtons(): void {
  if (!wins.peer || wins.peer.isDestroyed()) return;
  const eff = currentEffective();
  wins.peer.webContents.send("peer-broadcast", { type: "buttons", buttons: eff.buttons.map(publicButton) });
}
