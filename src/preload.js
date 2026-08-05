const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("touchdeck", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getIcon: (name) => ipcRenderer.invoke("get-icon", name),
  press: (id) => ipcRenderer.invoke("press", id),
  startDrag: () => ipcRenderer.send("start-drag"),
  stopDrag: () => ipcRenderer.send("stop-drag"),
  debugShot: () => ipcRenderer.invoke("debug-shot"),
  // 悬浮球模式（bubble.html / menu.html）
  closeMenu: () => ipcRenderer.send("close-menu"),
  toggleMenu: () => ipcRenderer.send("toggle-menu"),
  select: (id) => ipcRenderer.send("menu-select", id),
  dismiss: () => ipcRenderer.send("close-menu"),
  onMenuInit: (cb) => ipcRenderer.on("menu-init", (_e, init) => cb(init)),
  onMenuConfirm: (cb) => ipcRenderer.on("menu-confirm", () => cb()),
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
});
