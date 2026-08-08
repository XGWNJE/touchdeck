// ===== P2P 中继（隐藏窗口跑 WebRTC，DataChannel 按键 → 本地注入）=====
import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT, wins, peerStatusBox } from "./state";
import { enqueueAction } from "./macro";
import { broadcastButtons } from "./foreground";
import { RequestLedger, actionResult, parseActionRequest, type ActionResult } from "../shared/action-protocol";

const requestLedger = new RequestLedger();

function sendResult(clientId: string, result: ActionResult): void {
  if (wins.peer && !wins.peer.isDestroyed()) wins.peer.webContents.send("peer-action-result", { clientId, result });
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRELOAD = path.join(HERE, "..", "preload", "index.cjs");
const APP_ICON = path.join(ROOT, "src", "assets", "app-icon.png");
const RENDERER_URL = process.env.ELECTRON_RENDERER_URL;

function createPeerWindow(): void {
  if (wins.peer && !wins.peer.isDestroyed()) return;
  const peerWin = new BrowserWindow({
    width: 1, height: 1, show: false, frame: false, skipTaskbar: true,
    icon: APP_ICON,
    webPreferences: { preload: PRELOAD, contextIsolation: true },
  });
  wins.peer = peerWin;
  if (!app.isPackaged && RENDERER_URL) peerWin.loadURL(`${RENDERER_URL}/peer/`);
  else peerWin.loadFile(path.join(ROOT, "out", "renderer", "peer", "index.html"));
  peerWin.webContents.on("console-message", (_e, _l, msg) => console.log("[peer]", msg));
  peerWin.on("closed", () => { wins.peer = null; });
}

export function registerPeerIpc(): void {
  ipcMain.on("peer-status", (_e, s) => {
    peerStatusBox.value = { ...peerStatusBox.value, ...s };
    if (wins.console && !wins.console.isDestroyed()) {
      wins.console.webContents.send("peer-status", peerStatusBox.value);
    }
  });
  ipcMain.handle("peer-start", (_e, signalUrl) => {
    createPeerWindow();
    peerStatusBox.value = { phase: "connecting" };
    // 页面加载完成前 send 会丢消息（模块脚本比旧内联脚本慢一拍，2026-08-06 实证 stuck 在 connecting）
    const send = () => wins.peer && !wins.peer.isDestroyed() && wins.peer.webContents.send("peer-start", signalUrl || null);
    if (wins.peer!.webContents.isLoading()) wins.peer!.webContents.once("did-finish-load", send);
    else send();
    return { ok: true };
  });
  ipcMain.handle("peer-stop", () => {
    if (wins.peer && !wins.peer.isDestroyed()) wins.peer.webContents.send("peer-stop");
    peerStatusBox.value = { phase: "idle" };
    return { ok: true };
  });
  ipcMain.handle("peer-status-get", () => peerStatusBox.value);
  ipcMain.on("peer-action", (_e, clientId: unknown, raw: unknown) => {
    if (typeof clientId !== "string") return;
    const request = parseActionRequest(raw);
    if (!request) return;
    const prior = requestLedger.get(clientId, request.requestId);
    if (prior) return sendResult(clientId, prior);
    const report = (result: ActionResult) => {
      requestLedger.record(clientId, result);
      sendResult(clientId, result);
    };
    const r = enqueueAction(request.buttonId, "peer", { requestId: request.requestId, onResult: report });
    if (r.ok) console.log("[touchdeck] peer action", request.requestId, request.buttonId);
  });
  // 设备通道上线：把当前有效按钮集推下去（安卓动态渲染；离线 panel.json 仅兜底）
  ipcMain.on("peer-channel-open", () => broadcastButtons());
}
