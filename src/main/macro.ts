// ===== 宏引擎：按钮动作 = 步骤序列（keys/text/paste/delay + times），纯输入模拟 =====
// 三个触发源（本机 press、菜单选择、P2P peer-press）统一进 FIFO 串行队列：
// 多设备并发触发时按键绝不交错（2026-08-05 定案：轻量复合指令，不做抢占/变量/分支）。
import { clipboard } from "electron";
import { resolveConfig, matchTarget, type KeyCombo, type PanelButton } from "../shared/config-resolve";
import { wins, fgCache } from "./state";
import { currentEffective } from "./foreground";
import { inspectForeground } from "./foreground";
import { type ActionResult, actionResult } from "../shared/action-protocol";
import { ActionQueue, type QueuedAction } from "../shared/action-queue";
import { HoldController, type HoldIdentity, type HoldReleaseReason } from "../shared/hold-controller";

// nut-js 是 ESM 包，用动态 import 按需加载（避免拖慢启动）
let nutKeyboard: any = null;
let nutKey: any = null;
async function ensureNut(): Promise<void> {
  if (!nutKeyboard) {
    const nut = await import("@nut-tree/nut-js");
    nutKeyboard = nut.keyboard;
    nutKey = nut.Key;
    // 默认 300ms 会让三键 hold 的 begin/end 各耗时数秒，触摸已经松开后才完成按下。
    // 保留少量间隔兼顾应用识别，同时让 200ms 防误触门槛后的反馈足够及时。
    nutKeyboard.config.autoDelayMs = 20;
  }
}

const KEY_MAP: Record<string, string> = {
  escape: "Escape",
  tab: "Tab",
  up: "Up",
  down: "Down",
  enter: "Return",
  backspace: "Backspace",
  space: "Space", delete: "Delete", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", left: "Left", right: "Right",
};

function nutKeyFor(key: string): any {
  const name = KEY_MAP[key] || (/^[a-z]$/.test(key) ? key.toUpperCase() : /^[0-9]$/.test(key) ? `Num${key}` : /^f\d{1,2}$/.test(key) ? key.toUpperCase() : key);
  const resolved = nutKey[name];
  if (resolved === undefined) throw new Error("unsupported-key");
  return resolved;
}

function comboKeys(keys: KeyCombo): any[] {
  const result: any[] = [];
  if (keys.ctrl) result.push(nutKey.LeftControl);
  if (keys.shift) result.push(nutKey.LeftShift);
  if (keys.alt) result.push(nutKey.LeftAlt);
  if (keys.win) result.push(nutKey.LeftSuper);
  if (keys.key) result.push(nutKeyFor(keys.key));
  return result;
}

async function sendKeys(keys: KeyCombo): Promise<void> {
  await ensureNut();
  if (keys.text) {
    await nutKeyboard.type(keys.text);
    return;
  }
  const mods: any[] = [];
  if (keys.ctrl) mods.push(nutKey.LeftControl);
  if (keys.shift) mods.push(nutKey.LeftShift);
  if (keys.alt) mods.push(nutKey.LeftAlt);
  if (keys.win) mods.push(nutKey.LeftSuper);
  try {
    for (const m of mods) await nutKeyboard.pressKey(m);
    if (keys.key) {
      const key = nutKeyFor(keys.key);
      await nutKeyboard.type(key);
    } else {
      // 纯修饰键组合（如微信输入法 Ctrl+Win+Shift 启动语音输入）：按住片刻即触发。
      // 时长可配（behavior.modifierHoldMs）：IME 热键识别要足够长的按住窗口，太短会漏触发。
      await new Promise((r) => setTimeout(r, resolveConfig().behavior.modifierHoldMs ?? 120));
    }
  } finally {
    for (const m of mods.reverse()) await nutKeyboard.releaseKey(m);
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
interface MacroQueueItem { btn: PanelButton; source: string; requestId?: string; onResult?: (result: ActionResult) => void; }
const ACTION_QUEUE_MAX = 16;

async function execStep(step: { keys?: KeyCombo; text?: string; paste?: string; delay?: number }): Promise<void> {
  await ensureNut();
  if (step.keys) return sendKeys(step.keys);
  if (step.text !== undefined) return nutKeyboard.type(step.text);
  if (step.paste !== undefined) {
    // 中文/长文本/多行走剪贴板 + Ctrl+V：键码注入打不出中文，
    // 剪贴板是不依赖目标应用 API 的唯一可靠通道
    clipboard.writeText(step.paste);
    await sleep(30); // 等剪贴板就绪再发粘贴键
    return sendKeys({ ctrl: true, key: "v" });
  }
  if (step.delay !== undefined) return sleep(step.delay);
}

async function runMacro(btn: PanelButton): Promise<void> {
  const gap = resolveConfig().behavior.macroStepGapMs ?? 40;
  const steps = btn.macro || (btn.keys ? [{ keys: btn.keys }] : []);
  if (!steps.length) throw new Error("按钮无动作配置");
  // 含 paste 的宏：执行前快照剪贴板、结束（含失败）后恢复，不偷用户的剪贴板
  const hasPaste = steps.some((s) => s.paste !== undefined);
  const clipBackup = hasPaste ? clipboard.readText() : null;
  try {
    for (const step of steps) {
      const times = step.times || 1;
      for (let i = 0; i < times; i++) {
        await execStep(step);
        if (gap > 0) await sleep(gap);
      }
    }
  } finally {
    if (clipBackup !== null) clipboard.writeText(clipBackup);
  }
}

export interface ActionFeedback {
  id: string; ok: boolean; reason?: string; source: string; blocked?: boolean;
}

export interface EnqueueOptions {
  requestId?: string;
  onResult?: (result: ActionResult) => void;
}

function reportRemote(options: EnqueueOptions, status: ActionResult["status"], reason?: string): void {
  if (options.requestId) options.onResult?.(actionResult(options.requestId, status, reason));
}

// 动作反馈统一通道：控制台可见（拦截/失败 toast），同时写主进程日志
function actionFeedback(fb: ActionFeedback): void {
  console.log("[touchdeck] action", JSON.stringify(fb));
  if (wins.console && !wins.console.isDestroyed()) {
    wins.console.webContents.send("action-feedback", fb);
  }
  // 兼容旧通道：远程来源的失败/拦截仍走 peer-press-failed（控制台 toast 沿用）
  if (fb.source === "peer" && !fb.ok && wins.console && !wins.console.isDestroyed()) {
    wins.console.webContents.send("peer-press-failed", fb.id);
  }
}

const actionQueue = new ActionQueue<MacroQueueItem>(ACTION_QUEUE_MAX);

const heldKeys = new Map<string, any[]>();
const holdController = new HoldController({
  begin: async (hold) => {
    const { buttons } = currentEffective();
    const btn = buttons.find((candidate) => candidate.id === hold.buttonId);
    if (!btn || btn.triggerMode !== "hold" || !btn.keys) throw new Error("invalid-hold-button");
    if (btn.target && !matchTarget(btn.target, inspectForeground())) throw new Error("target-unavailable");
    await ensureNut();
    const pressed: any[] = [];
    try {
      for (const key of comboKeys(btn.keys)) {
        await nutKeyboard.pressKey(key);
        pressed.push(key);
      }
      heldKeys.set(hold.interactionId, pressed);
    } catch (error) {
      for (const key of pressed.reverse()) { try { await nutKeyboard.releaseKey(key); } catch { /* 继续释放 */ } }
      throw error;
    }
  },
  release: async (hold) => {
    await ensureNut();
    const keys = heldKeys.get(hold.interactionId) || [];
    heldKeys.delete(hold.interactionId);
    let failed = false;
    for (const key of [...keys].reverse()) {
      try { await nutKeyboard.releaseKey(key); } catch { failed = true; }
    }
    if (failed) throw new Error("release-error");
  },
  onAutomaticRelease: (hold, result, reason) => actionFeedback({ id: hold.buttonId, ok: result.status === "released", reason, source: "peer" }),
});

export async function beginHold(identity: HoldIdentity) { return holdController.begin(identity); }
export async function endHold(identity: HoldIdentity) { return holdController.end(identity); }
export async function releaseClientHold(clientId: string, reason: HoldReleaseReason = "disconnect") { return holdController.releaseClient(clientId, reason); }
export async function releaseAllHolds(reason: HoldReleaseReason = "host-stop") { return holdController.releaseAll(reason); }
export function validateHoldButton(buttonId: string): { ok: boolean; status?: "blocked" | "failed"; reason?: string } {
  const btn = currentEffective().buttons.find((candidate) => candidate.id === buttonId);
  if (!btn || btn.triggerMode !== "hold" || !btn.keys) return { ok: false, status: "failed", reason: "invalid-hold-button" };
  if (btn.target && !matchTarget(btn.target, inspectForeground())) return { ok: false, status: "blocked", reason: "target-unavailable" };
  return { ok: true };
}

function queueAction(item: MacroQueueItem): boolean {
  const action: QueuedAction<MacroQueueItem> = {
    value: item,
    beforeExecute: () => {
      const currentForeground = item.btn.target ? inspectForeground() : fgCache;
      if (item.btn.target && !matchTarget(item.btn.target, currentForeground)) {
        return "target-changed";
      }
      return undefined;
    },
    execute: () => runMacro(item.btn),
    onResult: (status, reason) => {
      if (status === "queued") {
        if (item.requestId) item.onResult?.(actionResult(item.requestId, "queued"));
        return;
      }
      if (status === "executed") {
        actionFeedback({ id: item.btn.id, ok: true, source: item.source });
      } else if (status === "blocked") {
        actionFeedback({ id: item.btn.id, ok: false, reason: "目标不匹配或前台探测失败", source: item.source, blocked: true });
      } else {
        actionFeedback({ id: item.btn.id, ok: false, reason: "执行异常", source: item.source });
      }
      if (item.requestId) item.onResult?.(actionResult(item.requestId, status, reason));
    },
  };
  return actionQueue.enqueue(action);
}

// 入队即完成同步校验（未配置/target 拦截），通过则排队串行执行
export function enqueueAction(buttonId: string, source: string, options: EnqueueOptions = {}): { ok: boolean; reason?: string; queued?: boolean } {
  if (holdController.activeHold) {
    actionFeedback({ id: buttonId, ok: false, reason: "hold-active", source });
    reportRemote(options, "failed", "hold-active");
    return { ok: false, reason: "hold-active" };
  }
  const { buttons } = currentEffective();
  const btn = buttons.find((b) => b.id === buttonId);
  if (!btn) {
    actionFeedback({ id: buttonId, ok: false, reason: "unconfigured", source });
    reportRemote(options, "failed", "unknown-button");
    return { ok: false, reason: "unconfigured" };
  }
  const currentForeground = btn.target ? inspectForeground() : fgCache;
  if (btn.target && !matchTarget(btn.target, currentForeground)) {
    const reason = `目标不匹配或前台探测失败：${currentForeground?.process || "未知"}`;
    actionFeedback({ id: buttonId, ok: false, reason, source, blocked: true });
    reportRemote(options, "blocked", "target-unavailable");
    return { ok: false, reason: "target-mismatch" };
  }
  const queued = queueAction({ btn, source, requestId: options.requestId, onResult: options.onResult });
  if (!queued) {
    actionFeedback({ id: buttonId, ok: false, reason: "队列溢出丢弃", source });
    return { ok: false, reason: "queue-full" };
  }
  return { ok: true, queued: true };
}
