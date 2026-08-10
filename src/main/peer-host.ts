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
let peerReady = false;
let pendingPeerStart = false;
let pendingSignalUrl: string | undefined;

function sendPendingStart(): void {
  if (!peerReady || !pendingPeerStart || !wins.peer || wins.peer.isDestroyed()) return;
  pendingPeerStart = false;
  wins.peer.webContents.send("peer-start", pendingSignalUrl || null);
}

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
  peerWin.on("closed", () => { wins.peer = null; peerReady = false; });
}

export function startPeer(signalUrl?: string): { ok: true } {
  createPeerWindow();
  peerStatusBox.value = { phase: "connecting" };
  // renderer 显式回报监听器已注册后才发送，冷启动不会把 peer-start 丢在模块执行之前。
  pendingSignalUrl = signalUrl;
  pendingPeerStart = true;
  sendPendingStart();
  return { ok: true };
}

export function registerPeerIpc(): void {
  ipcMain.on("peer-ready", () => { peerReady = true; sendPendingStart(); });
  ipcMain.on("peer-status", (_e, s) => {
    peerStatusBox.value = { ...peerStatusBox.value, ...s };
    if (wins.console && !wins.console.isDestroyed()) {
      wins.console.webContents.send("peer-status", peerStatusBox.value);
    }
  });
  ipcMain.handle("peer-start", (_e, signalUrl) => startPeer(signalUrl));
  ipcMain.handle("peer-stop", () => {
    if (wins.peer && !wins.peer.isDestroyed()) wins.peer.webContents.send("peer-stop");
    peerStatusBox.value = { phase: "idle" };
    return { ok: true };
  });
  ipcMain.handle("peer-status-get", () => peerStatusBox.value);
  ipcMain.handle("peer-create-pair-key", () => {
    if (!wins.peer || wins.peer.isDestroyed() || !peerReady) {
      return { ok: false, reason: "peer-unavailable" };
    }
    wins.peer.webContents.send("peer-create-pair-key");
    return { ok: true };
  });
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
