// 预加载脚本：contextBridge 暴露面 = IPC 契约（迁移冻结面，渲染层重构不动这里）。
// 注意：本文件以 CJS 形式构建（index.cjs）——渲染进程默认 sandbox 只支持 CJS preload。
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

contextBridge.exposeInMainWorld("touchdeck", {
  getConfig: () => ipcRenderer.invoke("get-config"),
  getIcon: (name: string) => ipcRenderer.invoke("get-icon", name),
  press: (id: string) => ipcRenderer.invoke("press", id),
  startDrag: () => ipcRenderer.send("start-drag"),
  stopDrag: () => ipcRenderer.send("stop-drag"),
  onDragEnded: (cb: () => void) => ipcRenderer.on("drag-ended", () => cb()),
  debugShot: () => ipcRenderer.invoke("debug-shot"),
  // 悬浮球模式（bubble / menu）
  closeMenu: () => ipcRenderer.send("close-menu"),
  toggleMenu: () => ipcRenderer.send("toggle-menu"),
  select: (id: string) => ipcRenderer.send("menu-select", id),
  dismiss: () => ipcRenderer.send("close-menu"),
  onMenuInit: (cb: (init: any) => void) => ipcRenderer.on("menu-init", (_e: IpcRendererEvent, init: any) => cb(init)),
  onMenuConfirm: (cb: () => void) => ipcRenderer.on("menu-confirm", () => cb()),
  onMenuReload: (cb: () => void) => ipcRenderer.on("menu-reload", () => cb()),
  // 控制台（console）
  consoleStatus: () => ipcRenderer.invoke("console-status"),
  consoleTogglePanel: () => ipcRenderer.invoke("console-toggle-panel"),
  actionBindingsGet: () => ipcRenderer.invoke("action-bindings-get"),
  actionBindingsSave: (value: unknown, confirmConflicts?: boolean) => ipcRenderer.invoke("action-bindings-save", value, confirmConflicts),
  actionBindingReset: (actionId: string) => ipcRenderer.invoke("action-binding-reset", actionId),
  actionBindingsResetAll: () => ipcRenderer.invoke("action-bindings-reset-all"),
  // P2P 中继（peer / 控制台）
  peerStart: (signalUrl?: string) => ipcRenderer.invoke("peer-start", signalUrl),
  peerStop: () => ipcRenderer.invoke("peer-stop"),
  peerStatusGet: () => ipcRenderer.invoke("peer-status-get"),
  peerCreatePairKey: () => ipcRenderer.invoke("peer-create-pair-key"),
  peerRevokeDevices: () => ipcRenderer.invoke("peer-revoke-devices"),
  peerReady: () => ipcRenderer.send("peer-ready"),
  onPeerStart: (cb: (url: string | null) => void) => ipcRenderer.on("peer-start", (_e: IpcRendererEvent, url: string | null) => cb(url)),
  onPeerStop: (cb: () => void) => ipcRenderer.on("peer-stop", () => cb()),
  onPeerCreatePairKey: (cb: () => void) => ipcRenderer.on("peer-create-pair-key", () => cb()),
  onPeerRevokeDevices: (cb: () => void) => ipcRenderer.on("peer-revoke-devices", () => cb()),
  peerStatus: (s: unknown) => ipcRenderer.send("peer-status", s),
  peerAction: (clientId: string, payload: unknown) => ipcRenderer.send("peer-action", clientId, payload),
  peerChannelClosed: (clientId: string, reason?: string) => ipcRenderer.send("peer-channel-closed", clientId, reason),
  onPeerStatus: (cb: (s: any) => void) => ipcRenderer.on("peer-status", (_e: IpcRendererEvent, s: any) => cb(s)),
  onPanelStatus: (cb: (s: any) => void) => ipcRenderer.on("panel-status", (_e: IpcRendererEvent, s: any) => cb(s)),
  onPeerPressFailed: (cb: (id: string) => void) => ipcRenderer.on("peer-press-failed", (_e: IpcRendererEvent, id: string) => cb(id)),
  // 宏引擎反馈（拦截/失败/成功）与场景切换通知（控制台可见性）
  onActionFeedback: (cb: (fb: any) => void) => ipcRenderer.on("action-feedback", (_e: IpcRendererEvent, fb: any) => cb(fb)),
  onScenarioChanged: (cb: (s: any) => void) => ipcRenderer.on("scenario-changed", (_e: IpcRendererEvent, s: any) => cb(s)),
  // 配置热重载结果（控制台提示配置错误/重载成功）
  onConfigReloaded: (cb: (s: any) => void) => ipcRenderer.on("config-reloaded", (_e: IpcRendererEvent, s: any) => cb(s)),
  // host→client 按钮集推送：主进程转发给 peer，经 DataChannel 广播
  onPeerBroadcast: (cb: (payload: any) => void) => ipcRenderer.on("peer-broadcast", (_e: IpcRendererEvent, payload: any) => cb(payload)),
  peerChannelOpen: () => ipcRenderer.send("peer-channel-open"),
  onPeerActionResult: (cb: (payload: any) => void) => ipcRenderer.on("peer-action-result", (_e: IpcRendererEvent, payload: any) => cb(payload)),
});
