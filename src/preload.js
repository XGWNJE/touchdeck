const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("touchdeck", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getIcon: (name) => ipcRenderer.invoke("get-icon", name),
  press: (id) => ipcRenderer.invoke("press", id),
  startDrag: () => ipcRenderer.send("start-drag"),
  stopDrag: () => ipcRenderer.send("stop-drag"),
  onBounds: (cb) => ipcRenderer.on("win-bounds", (_e, b) => cb(b)),
  debugShot: () => ipcRenderer.invoke("debug-shot"),
});
