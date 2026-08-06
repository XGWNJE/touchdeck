// 通用 IPC：配置/图标/注入/诊断截屏 + 控制台启停。
// 在 app.whenReady 统一注册，不挂某个窗口的创建流程上（窗口重建不叠加监听）。
import { ipcMain, screen, desktopCapturer } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resolveConfig, resolveIcon } from "../shared/config-resolve";
import { ROOT, wins, iconCache, fgCache, loadState, saveState } from "./state";
import { currentEffective } from "./foreground";
import { enqueueAction } from "./macro";
import { panelDisabled, panelRunning, startPanel, stopPanel } from "./windows";

export function registerCommonIpc(): void {
  // 配置 + 当前有效按钮集（aux 常驻 + 场景命中）+ 前台状态：菜单渲染与控制台共用
  ipcMain.handle("get-config", () => {
    const eff = currentEffective();
    return {
      ...eff.config,
      effectiveButtons: eff.buttons,
      effectiveLayout: eff.layout,
      activeScenario: eff.scenario,
      foreground: fgCache.process || null,
    };
  });

  ipcMain.handle("get-icon", (_e, name: string) => {
    if (!iconCache.has(name)) iconCache.set(name, resolveIcon(resolveConfig().themeName, name));
    return iconCache.get(name);
  });

  // 本机面板触发：同步校验（未配置/target 拦截）后入宏队列串行执行
  ipcMain.handle("press", (_e, buttonId: string) => enqueueAction(buttonId, "local"));

  // 临时诊断：截全屏验证窗口真实可见性（desktopCapturer 走 WGC，能抓透明分层窗口）
  ipcMain.handle("debug-shot", async () => {
    try {
      const size = screen.getPrimaryDisplay().size;
      const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: size });
      fs.writeFileSync(path.join(ROOT, "prototype", "screen-dbg.png"), sources[0].thumbnail.toPNG());
    } catch (e: any) {
      console.error("[touchdeck] debug-shot 失败（打包版 asar 只读属预期）:", e.message);
    }
  });
}

export function registerConsoleIpc(): void {
  ipcMain.handle("console-status", async () => {
    return {
      panelRunning: !panelDisabled() && panelRunning(),
      panelDisabled: panelDisabled(),
    };
  });

  ipcMain.handle("console-toggle-panel", async () => {
    if (panelDisabled()) {
      // 开启面板：清掉关闭标记并启动
      const s = loadState() || {};
      saveState({ ...s, panel: true });
      startPanel();
    } else {
      stopPanel();
      const s = loadState() || {};
      saveState({ ...s, panel: false });
    }
    return { running: !panelDisabled() && panelRunning() };
  });
}
