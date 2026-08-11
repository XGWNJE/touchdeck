import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import {
  defaultActionBindings,
  validateActionBindings,
  type ActionBindingsFile,
  type LockedActionId,
} from "../shared/action-bindings";

export const ACTION_BINDINGS_FILENAME = "action-bindings.json";

export function actionBindingsPath(): string {
  return path.join(app.getPath("userData"), ACTION_BINDINGS_FILENAME);
}

export function loadActionBindings(filePath = actionBindingsPath()): ActionBindingsFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return validateActionBindings(parsed) || defaultActionBindings();
  } catch {
    return defaultActionBindings();
  }
}

export function saveActionBindings(value: unknown, filePath = actionBindingsPath()): ActionBindingsFile {
  const bindings = validateActionBindings(value);
  if (!bindings) throw new Error("invalid-action-bindings");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const backupPath = `${filePath}.${process.pid}.${Date.now()}.bak`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(bindings, null, 2) + "\n", { encoding: "utf-8", flag: "wx" });
    // Windows 不允许 rename 覆盖现有文件：先把旧文件原子移到同目录备份，再换入新文件。
    // 换入失败时恢复备份，任何时刻至少保留一份完整 JSON。
    if (fs.existsSync(filePath)) fs.renameSync(filePath, backupPath);
    fs.renameSync(temporaryPath, filePath);
    try { fs.unlinkSync(backupPath); } catch { /* 首次保存没有备份 */ }
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* 文件可能尚未创建 */ }
    if (!fs.existsSync(filePath) && fs.existsSync(backupPath)) {
      try { fs.renameSync(backupPath, filePath); } catch { /* 保留 .bak 供人工恢复 */ }
    }
    throw error;
  }
  return bindings;
}

export function resetActionBinding(actionId: LockedActionId, filePath = actionBindingsPath()): ActionBindingsFile {
  const current = loadActionBindings(filePath);
  current.bindings[actionId] = defaultActionBindings().bindings[actionId];
  return saveActionBindings(current, filePath);
}

export function resetAllActionBindings(filePath = actionBindingsPath()): ActionBindingsFile {
  return saveActionBindings(defaultActionBindings(), filePath);
}
