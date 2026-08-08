// 远程动作协议：不依赖 Electron/Android，供 Host、WebRTC 层和自动化测试共用。
export const ACTION_PROTOCOL_VERSION = 1;

export type ActionStatus = "queued" | "executed" | "blocked" | "failed" | "disconnected" | "timeout";

export interface ActionRequest {
  v: typeof ACTION_PROTOCOL_VERSION;
  type: "action";
  requestId: string;
  buttonId: string;
}

export interface ActionResult {
  v: typeof ACTION_PROTOCOL_VERSION;
  type: "action-result";
  requestId: string;
  status: ActionStatus;
  reason?: string;
}

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUTTON_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export function parseActionRequest(value: unknown): ActionRequest | null {
  if (!value || typeof value !== "object") return null;
  const msg = value as Record<string, unknown>;
  if (msg.v !== ACTION_PROTOCOL_VERSION || msg.type !== "action") return null;
  if (typeof msg.requestId !== "string" || !REQUEST_ID.test(msg.requestId)) return null;
  if (typeof msg.buttonId !== "string" || !BUTTON_ID.test(msg.buttonId)) return null;
  return { v: ACTION_PROTOCOL_VERSION, type: "action", requestId: msg.requestId, buttonId: msg.buttonId };
}

export function actionResult(requestId: string, status: ActionStatus, reason?: string): ActionResult {
  return { v: ACTION_PROTOCOL_VERSION, type: "action-result", requestId, status, ...(reason ? { reason } : {}) };
}

// 同一设备的同一 requestId 只会进入宏队列一次。重复包返回已知状态，供客户端安全重试。
export class RequestLedger {
  private readonly entries = new Map<string, ActionResult>();
  constructor(private readonly limit = 256) {}

  get(clientId: string, requestId: string): ActionResult | undefined {
    return this.entries.get(`${clientId}:${requestId}`);
  }

  record(clientId: string, result: ActionResult): void {
    const key = `${clientId}:${result.requestId}`;
    this.entries.delete(key);
    this.entries.set(key, result);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value!);
  }
}
