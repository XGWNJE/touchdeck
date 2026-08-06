const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("touchdeck", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getIcon: (name) => ipcRenderer.invoke("get-icon", name),
  press: (id) => ipcRenderer.invoke("press", id),
  startDrag: () => ipcRenderer.send("start-drag"),
  stopDrag: () => ipcRenderer.send("stop-drag"),
  onDragEnded: (cb) => ipcRenderer.on("drag-ended", () => cb()),
  debugShot: () => ipcRenderer.invoke("debug-shot"),
  // 悬浮球模式（bubble.html / menu.html）
  closeMenu: () => ipcRenderer.send("close-menu"),
  toggleMenu: () => ipcRenderer.send("toggle-menu"),
  select: (id) => ipcRenderer.send("menu-select", id),
  dismiss: () => ipcRenderer.send("close-menu"),
  onMenuInit: (cb) => ipcRenderer.on("menu-init", (_e, init) => cb(init)),
  onMenuConfirm: (cb) => ipcRenderer.on("menu-confirm", () => cb()),
  onMenuReload: (cb) => ipcRenderer.on("menu-reload", () => cb()),
  // 控制台（console.html）
  consoleStatus: () => ipcRenderer.invoke("console-status"),
  consoleTogglePanel: () => ipcRenderer.invoke("console-toggle-panel"),
  // P2P 中继（peer.html / 控制台）
  peerStart: (signalUrl) => ipcRenderer.invoke("peer-start", signalUrl),
  peerStop: () => ipcRenderer.invoke("peer-stop"),
  peerStatusGet: () => ipcRenderer.invoke("peer-status-get"),
  onPeerStart: (cb) => ipcRenderer.on("peer-start", (_e, url) => cb(url)),
  onPeerStop: (cb) => ipcRenderer.on("peer-stop", () => cb()),
  peerStatus: (s) => ipcRenderer.send("peer-status", s),
  peerPress: (id) => ipcRenderer.send("peer-press", id),
  onPeerStatus: (cb) => ipcRenderer.on("peer-status", (_e, s) => cb(s)),
  onPanelStatus: (cb) => ipcRenderer.on("panel-status", (_e, s) => cb(s)),
  onPeerPressFailed: (cb) => ipcRenderer.on("peer-press-failed", (_e, id) => cb(id)),
  // 宏引擎反馈（拦截/失败/成功）与场景切换通知（控制台可见性）
  onActionFeedback: (cb) => ipcRenderer.on("action-feedback", (_e, fb) => cb(fb)),
  onScenarioChanged: (cb) => ipcRenderer.on("scenario-changed", (_e, s) => cb(s)),
  // 配置热重载结果（控制台提示配置错误/重载成功）
  onConfigReloaded: (cb) => ipcRenderer.on("config-reloaded", (_e, s) => cb(s)),
  // host→client 按钮集推送：主进程转发给 peer.html，经 DataChannel 广播
  onPeerBroadcast: (cb) => ipcRenderer.on("peer-broadcast", (_e, payload) => cb(payload)),
  peerChannelOpen: () => ipcRenderer.send("peer-channel-open"),
});
