// TouchDeck 主进程入口：无框置顶悬浮球面板，点击不抢焦点，按键经 nut-js 发到目标窗口。
// 模块划分：state（共享状态）/ win32（koffi 函数层）/ macro（宏引擎）/ foreground（前台探测+场景）/
// windows（窗口与托盘）/ drag（拖球）/ peer-host（P2P 中继）/ hotreload（配置热重载）/ ipc（通用 IPC）。
import { app, globalShortcut, screen } from "electron";
import fs from "node:fs";
import path from "node:path";
import { ROOT, wins } from "./state";
import { setExternalConfigDir } from "../shared/config-resolve";
import { registerCommonIpc, registerConsoleIpc } from "./ipc";
import { registerDragIpc } from "./drag";
import { registerPeerIpc, releasePeerHoldsForShutdown, startPeer } from "./peer-host";
import { registerConfigWatch } from "./hotreload";
import { pollForeground } from "./foreground";
import {
  createConsoleWindow, createTray, registerMenuIpc,
  startPanel, closeMenuWindow,
} from "./windows";

// Windows 用稳定的应用 ID 归组任务栏窗口；窗口图标由 BrowserWindow.icon 提供。
app.setAppUserModelId("cn.touchdeck.app");

// ===== 启动 =====
// 单实例锁：重复启动直接退出，避免桌面快捷方式连点开出两个面板；
// 二次启动（快捷方式再点）时把控制台窗口拉回前台
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (wins.console && !wins.console.isDestroyed()) {
      if (wins.console.isMinimized()) wins.console.restore();
      wins.console.show();
      wins.console.focus();
    }
  });
}

app.whenReady().then(() => {
  // 打包版配置外置（asar 只读）：首启把包内默认配置播种到 userData，之后一律外置优先读
  if (app.isPackaged) {
    const dir = app.getPath("userData");
    setExternalConfigDir(dir);
    const target = path.join(dir, "touchdeck.config.json");
    try {
      if (!fs.existsSync(target)) {
        fs.copyFileSync(path.join(ROOT, "touchdeck.config.json"), target);
        console.log("[touchdeck] 配置播种到 userData:", target);
      }
    } catch (e: any) {
      console.error("[touchdeck] 配置播种失败:", e.message);
    }
  }
  registerCommonIpc();
  registerConsoleIpc();
  registerDragIpc();
  registerPeerIpc();
  // 仅用于本机自动化验收；正式运行没有该环境变量，不改变用户的手动开启方式。
  if (process.env.TOUCHDECK_E2E_P2P === "1" || process.argv.includes("--touchdeck-e2e-p2p")) startPeer();
  registerMenuIpc();
  createConsoleWindow();
  createTray();
  registerConfigWatch();
  startPanel(); // 控制台打开时自动按配置启动面板（开箱即用）

  // 前台窗口轮询：target 校验与场景切换的判定依据（500ms 缓存，不入注入热路径）
  pollForeground();
  setInterval(pollForeground, 500);

  // 系统缩放/分辨率变化：重建面板（球/菜单尺寸位置随新 DPI 校正），防抖 500ms
  let dpiTimer: NodeJS.Timeout | null = null;
  screen.on("display-metrics-changed", () => {
    if (dpiTimer) clearTimeout(dpiTimer);
    dpiTimer = setTimeout(() => {
      console.log("[touchdeck] display metrics changed, rebuilding panel");
      closeMenuWindow();
      startPanel();
    }, 500);
  });
});

// 托盘「退出」与真实退出：放行窗口关闭
let releaseBeforeQuit = false;
app.on("before-quit", (event) => {
  if (!releaseBeforeQuit) {
    event.preventDefault();
    releaseBeforeQuit = true;
    void releasePeerHoldsForShutdown().finally(() => app.quit());
    return;
  }
  (app as any).isQuitting = true;
});
app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => app.quit());
