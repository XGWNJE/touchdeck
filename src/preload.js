const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("touchdeck", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getIcon: (name) => ipcRenderer.invoke("get-icon", name),
  press: (id) => ipcRenderer.invoke("press", id),
  startDrag: () => ipcRenderer.send("start-drag"),
  stopDrag: () => ipcRenderer.send("stop-drag"),
  onBounds: (cb) => ipcRenderer.on("win-bounds", (_e, b) => cb(b)),
  debugShot: () => ipcRenderer.invoke("debug-shot"),
  // 悬浮球模式（bubble.html / menu.html）
  openMenu: (mode) => ipcRenderer.send("open-menu", mode),
  closeMenu: () => ipcRenderer.send("close-menu"),
  toggleMenu: () => ipcRenderer.send("toggle-menu"),
  menuPointer: (x, y, action) => ipcRenderer.send("menu-pointer", x, y, action),
  select: (id) => ipcRenderer.send("menu-select", id),
  dismiss: () => ipcRenderer.send("close-menu"),
  onMenuInit: (cb) => ipcRenderer.on("menu-init", (_e, init) => cb(init)),
  onMenuPointer: (cb) => ipcRenderer.on("menu-pointer", (_e, x, y, action) => cb(x, y, action)),
  onMenuConfirm: (cb) => ipcRenderer.on("menu-confirm", () => cb()),
  // 控制台（console.html）
  consoleStatus: () => ipcRenderer.invoke("console-status"),
  consoleSetMode: (mode) => ipcRenderer.invoke("console-set-mode", mode),
  consoleSetInput: (input) => ipcRenderer.invoke("console-set-input", input),
  consoleTogglePanel: () => ipcRenderer.invoke("console-toggle-panel"),
  consoleOpenPanel: () => ipcRenderer.invoke("console-open-panel"),
  // P2P 中继（peer.html / 控制台）
  peerStart: (signalUrl) => ipcRenderer.invoke("peer-start", signalUrl),
  peerStop: () => ipcRenderer.invoke("peer-stop"),
  peerStatusGet: () => ipcRenderer.invoke("peer-status-get"),
  onPeerStart: (cb) => ipcRenderer.on("peer-start", (_e, url) => cb(url)),
  onPeerStop: (cb) => ipcRenderer.on("peer-stop", () => cb()),
  peerStatus: (s) => ipcRenderer.send("peer-status", s),
  peerPress: (id) => ipcRenderer.send("peer-press", id),
  onPeerStatus: (cb) => ipcRenderer.on("peer-status", (_e, s) => cb(s)),
});
