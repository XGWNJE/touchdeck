// ===== 配置热重载（2026-08-06）=====
// 监听用户配置 + 布局包 + 主题包：改动后清图标缓存 → 重建面板（球尺寸/缩放/主题可能变）
// → 重推安卓按钮集 → 控制台提示配置错误。JSON 改坏时 resolveConfig 沿用上一份有效配置，
// 注入链路不被打断。编辑器保存常连发多个事件（原子替换写入），防抖 400ms 合并成一次。
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig } from "../shared/config-resolve";
import { ROOT, wins, iconCache } from "./state";
import { startPanel, closeMenuWindow, panelDisabled } from "./windows";
import { broadcastButtons } from "./foreground";

export function registerConfigWatch(): void {
  // 打包版跳过：asar 只读且 fs.watch 不支持（ENOENT），配置文件随包固定；
  // 用户配置外置 userData 是后续项（届时此处改为监听外置路径）
  if (app.isPackaged) {
    console.log("[touchdeck] 打包版跳过配置热重载监听（asar 只读）");
    return;
  }
  let timer: NodeJS.Timeout | null = null;
  const onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      console.log("[touchdeck] 配置变更，热重载");
      const config = resolveConfig();
      iconCache.clear();
      closeMenuWindow();
      if (!panelDisabled()) startPanel();
      broadcastButtons();
      if (wins.console && !wins.console.isDestroyed()) {
        wins.console.webContents.send("config-reloaded", { errors: config.configErrors || [] });
      }
    }, 400);
  };
  try {
    // 根目录只认用户配置文件（state.json 等运行时写入过滤掉，防拖球触发重载循环）
    fs.watch(ROOT, (_e, f) => { if (f === "touchdeck.config.json") onChange(); });
    fs.watch(path.join(ROOT, "layouts"), onChange);
    try {
      fs.watch(path.join(ROOT, "themes"), { recursive: true }, onChange);
    } catch {
      // 无 recursive 支持的平台：逐主题子目录挂监听
      for (const d of fs.readdirSync(path.join(ROOT, "themes"), { withFileTypes: true })) {
        if (d.isDirectory()) fs.watch(path.join(ROOT, "themes", d.name), onChange);
      }
    }
  } catch (e: any) {
    console.error("[touchdeck] 配置监听注册失败:", e.message);
  }
}
