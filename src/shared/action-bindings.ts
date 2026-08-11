import type { KeyCombo } from "./config-resolve";

export type LockedActionId = "voice" | "esc" | "enter" | "newline" | "paste" | "command-menu" | "clear-input" | "delete-word" | "slash";
export type TriggerMode = "tap" | "hold";

export interface ActionBinding {
  presetId: string;
  keys: KeyCombo;
  triggerMode: TriggerMode;
}

export interface ActionBindingsFile {
  schemaVersion: 1;
  bindings: Record<LockedActionId, ActionBinding>;
}

export interface BindingPreset extends ActionBinding {
  label: string;
  description: string;
  tapCount?: 2;
  macro?: readonly KeyCombo[];
  text?: string;
}

export const ACTION_BINDINGS_SCHEMA_VERSION = 1 as const;
export const LOCKED_ACTION_IDS: readonly LockedActionId[] = [
  "voice", "esc", "enter", "newline", "paste", "command-menu",
  "clear-input", "delete-word", "slash",
];

export const ACTION_BINDING_PRESETS: Record<LockedActionId, readonly BindingPreset[]> = {
  voice: [
    { presetId: "codex-dictation", label: "Codex 听写", description: "Ctrl+Shift+D，按住说话", keys: { ctrl: true, shift: true, key: "d" }, triggerMode: "hold" },
    { presetId: "wechat-input", label: "微信输入法", description: "Ctrl+Win+Shift", keys: { ctrl: true, win: true, shift: true }, triggerMode: "tap" },
    { presetId: "windows-voice-typing", label: "Windows 语音输入", description: "Win+H", keys: { win: true, key: "h" }, triggerMode: "tap" },
  ],
  esc: [
    { presetId: "recommended", label: "推荐", description: "Esc ×2", keys: { key: "escape" }, triggerMode: "tap", tapCount: 2 },
  ],
  enter: [
    { presetId: "recommended", label: "推荐", description: "Enter", keys: { key: "enter" }, triggerMode: "tap" },
  ],
  newline: [
    { presetId: "recommended", label: "推荐", description: "Shift+Enter", keys: { shift: true, key: "enter" }, triggerMode: "tap" },
  ],
  paste: [
    { presetId: "recommended", label: "推荐", description: "Ctrl+V", keys: { ctrl: true, key: "v" }, triggerMode: "tap" },
  ],
  "command-menu": [
    { presetId: "codex-recommended", label: "Codex 推荐", description: "Ctrl+K", keys: { ctrl: true, key: "k" }, triggerMode: "tap" },
  ],
  "clear-input": [
    { presetId: "recommended", label: "推荐", description: "Ctrl+A → Backspace", keys: { ctrl: true, key: "a" }, triggerMode: "tap", macro: [{ ctrl: true, key: "a" }, { key: "backspace" }] },
  ],
  "delete-word": [
    { presetId: "recommended", label: "推荐", description: "Ctrl+Backspace", keys: { ctrl: true, key: "backspace" }, triggerMode: "tap" },
  ],
  slash: [
    { presetId: "recommended", label: "推荐", description: "输入 /", keys: { shift: true, key: "7" }, triggerMode: "tap", text: "/" },
  ],
};

export function bindingSteps(actionId: LockedActionId, binding: ActionBinding): Array<{ keys: KeyCombo }> {
  if (binding.triggerMode !== "tap" || binding.presetId === "custom") return [{ keys: { ...binding.keys } }];
  const preset = ACTION_BINDING_PRESETS[actionId].find((candidate) => candidate.presetId === binding.presetId);
  if (preset?.macro) return preset.macro.map((keys) => ({ keys: { ...keys } }));
  if (preset?.text !== undefined) return [{ keys: { text: preset.text } }];
  const count = preset?.tapCount ?? 1;
  return Array.from({ length: count }, () => ({ keys: { ...binding.keys } }));
}

export function bindingTapCount(actionId: LockedActionId, binding: ActionBinding): 1 | 2 {
  if (binding.triggerMode !== "tap" || binding.presetId === "custom") return 1;
  const preset = ACTION_BINDING_PRESETS[actionId].find((candidate) => candidate.presetId === binding.presetId);
  return preset?.tapCount ?? 1;
}

const ALLOWED_KEYS = new Set([
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "q", "r", "s", "t", "u", "v", "w", "x", "y", "z",
  "0", "1", "2", "3", "4", "5", "6", "7", "8", "9",
  "escape", "tab", "enter", "backspace", "space", "delete", "home", "end",
  "pageup", "pagedown", "up", "down", "left", "right",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeKeyCombo(value: unknown): KeyCombo | null {
  if (!isObject(value)) return null;
  const allowedFields = new Set(["ctrl", "shift", "alt", "win", "key"]);
  if (Object.keys(value).some((key) => !allowedFields.has(key))) return null;
  for (const modifier of ["ctrl", "shift", "alt", "win"] as const) {
    if (value[modifier] !== undefined && typeof value[modifier] !== "boolean") return null;
  }
  if (value.key !== undefined && typeof value.key !== "string") return null;
  const key = typeof value.key === "string" ? value.key.trim().toLowerCase() : undefined;
  if (key !== undefined && !ALLOWED_KEYS.has(key)) return null;
  const result: KeyCombo = {};
  if (value.ctrl === true) result.ctrl = true;
  if (value.shift === true) result.shift = true;
  if (value.alt === true) result.alt = true;
  if (value.win === true) result.win = true;
  if (key) result.key = key;
  if (!result.ctrl && !result.shift && !result.alt && !result.win && !result.key) return null;
  return result;
}

export function canonicalKeyCombo(value: KeyCombo): string | null {
  const keys = normalizeKeyCombo(value);
  if (!keys) return null;
  return [keys.ctrl ? "ctrl" : "", keys.shift ? "shift" : "", keys.alt ? "alt" : "", keys.win ? "win" : "", keys.key || ""]
    .filter(Boolean)
    .join("+");
}

export function findBindingConflicts(bindings: Record<LockedActionId, ActionBinding>): Array<{ signature: string; actionIds: LockedActionId[] }> {
  const grouped = new Map<string, LockedActionId[]>();
  for (const actionId of LOCKED_ACTION_IDS) {
    const signature = canonicalKeyCombo(bindings[actionId].keys);
    if (!signature) continue;
    const ids = grouped.get(signature) || [];
    ids.push(actionId);
    grouped.set(signature, ids);
  }
  return [...grouped.entries()]
    .filter(([, actionIds]) => actionIds.length > 1)
    .map(([signature, actionIds]) => ({ signature, actionIds }));
}

export function defaultActionBindings(): ActionBindingsFile {
  return {
    schemaVersion: ACTION_BINDINGS_SCHEMA_VERSION,
    bindings: {
      voice: copyBinding(ACTION_BINDING_PRESETS.voice[0]),
      esc: copyBinding(ACTION_BINDING_PRESETS.esc[0]),
      enter: copyBinding(ACTION_BINDING_PRESETS.enter[0]),
      newline: copyBinding(ACTION_BINDING_PRESETS.newline[0]),
      paste: copyBinding(ACTION_BINDING_PRESETS.paste[0]),
      "command-menu": copyBinding(ACTION_BINDING_PRESETS["command-menu"][0]),
      "clear-input": copyBinding(ACTION_BINDING_PRESETS["clear-input"][0]),
      "delete-word": copyBinding(ACTION_BINDING_PRESETS["delete-word"][0]),
      slash: copyBinding(ACTION_BINDING_PRESETS.slash[0]),
    },
  };
}

function copyBinding(binding: ActionBinding): ActionBinding {
  return { presetId: binding.presetId, keys: { ...binding.keys }, triggerMode: binding.triggerMode };
}

export function validateActionBindings(value: unknown): ActionBindingsFile | null {
  if (!isObject(value) || value.schemaVersion !== ACTION_BINDINGS_SCHEMA_VERSION || !isObject(value.bindings)) return null;
  if (Object.keys(value).some((key) => key !== "schemaVersion" && key !== "bindings")) return null;
  if (Object.keys(value.bindings).length !== LOCKED_ACTION_IDS.length) return null;
  const result = defaultActionBindings();
  for (const actionId of LOCKED_ACTION_IDS) {
    const raw = value.bindings[actionId];
    if (!isObject(raw) || Object.keys(raw).some((key) => !["presetId", "keys", "triggerMode"].includes(key))) return null;
    if (typeof raw.presetId !== "string" || !raw.presetId || (raw.triggerMode !== "tap" && raw.triggerMode !== "hold")) return null;
    const keys = normalizeKeyCombo(raw.keys);
    if (!keys) return null;
    const knownPreset = ACTION_BINDING_PRESETS[actionId].find((preset) => preset.presetId === raw.presetId);
    if (raw.presetId !== "custom") {
      if (!knownPreset || canonicalKeyCombo(knownPreset.keys) !== canonicalKeyCombo(keys) || knownPreset.triggerMode !== raw.triggerMode) return null;
    }
    result.bindings[actionId] = { presetId: raw.presetId, keys, triggerMode: raw.triggerMode };
  }
  return result;
}
