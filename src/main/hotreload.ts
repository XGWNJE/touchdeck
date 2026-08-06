// ===== 配置热重载（2026-08-06）=====
// 监听生效的用户配置 + 布局包 + 主题包：改动后清图标缓存 → 重建面板（球尺寸/缩放/主题可能变）
// → 重推安卓按钮集 → 控制台提示配置错误。JSON 改坏时 resolveConfig 沿用上一份有效配置，
// 注入链路不被打断。编辑器保存常连发多个事件（原子替换写入），防抖 400ms 合并成一次。
// 监听目标：dev = 仓库根；打包版 = userData 外置目录（asar 只读，fs.watch 不支持）。
import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig, getExternalConfigDir } from "../shared/config-resolve";
import { ROOT, wins, iconCache } from "./state";
import { startPanel, closeMenuWindow, panelDisabled } from "./windows";
import { broadcastButtons } from "./foreground";

export function registerConfigWatch(): void {
  // 配置根：打包版 = userData（外置优先查找的配置/布局/主题都读这里）；dev = 仓库根
  const watchRoot = app.isPackaged ? getExternalConfigDir() : ROOT;
  if (!watchRoot) return;

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
    // 根目录只认用户配置文件（state.json 等运行时写入过滤掉，防拖球触发重载循环）；
    // 监听父目录而非文件本体：编辑器原子替换（写临时文件再改名）会弄丢文件级 watch
    fs.watch(watchRoot, (_e, f) => { if (f === "touchdeck.config.json") onChange(); });
    // 布局/主题包：dev 必存在；打包版用户可能没建（纯默认配置），存在才监听
    const layoutsDir = path.join(watchRoot, "layouts");
    const themesDir = path.join(watchRoot, "themes");
    if (fs.existsSync(layoutsDir)) fs.watch(layoutsDir, onChange);
    if (fs.existsSync(themesDir)) {
      try {
        fs.watch(themesDir, { recursive: true }, onChange);
      } catch {
        // 无 recursive 支持的平台：逐主题子目录挂监听
        for (const d of fs.readdirSync(themesDir, { withFileTypes: true })) {
          if (d.isDirectory()) fs.watch(path.join(themesDir, d.name), onChange);
        }
      }
    }
    console.log("[touchdeck] 配置热重载监听:", watchRoot);
  } catch (e: any) {
    console.error("[touchdeck] 配置监听注册失败:", e.message);
  }
}
