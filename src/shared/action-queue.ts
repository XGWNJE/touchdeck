import { type ActionStatus } from "./action-protocol";

export interface QueuedAction<T> {
  value: T;
  // 在实际执行前二次检查；返回原因即代表 blocked。
  beforeExecute?: () => string | undefined;
  execute: () => Promise<void>;
  onResult: (status: Extract<ActionStatus, "queued" | "executed" | "blocked" | "failed">, reason?: string) => void;
}

// 单消费者 FIFO：只处理生命周期，不了解按钮、前台窗口或 Electron。
// 这样可靠性异常路径能在不注入真实按键的情况下自动测试。
export class ActionQueue<T> {
  private readonly queue: QueuedAction<T>[] = [];
  private running = false;

  constructor(private readonly max = 16) {}

  enqueue(action: QueuedAction<T>): boolean {
    if (this.queue.length >= this.max) {
      action.onResult("failed", "queue-full");
      return false;
    }
    this.queue.push(action);
    action.onResult("queued");
    void this.pump();
    return true;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    while (this.queue.length) {
      const action = this.queue.shift()!;
      const blocked = action.beforeExecute?.();
      if (blocked) {
        action.onResult("blocked", blocked);
        continue;
      }
      try {
        await action.execute();
        action.onResult("executed");
      } catch {
        // 执行细节不能进入协议 ACK 或日志；调用方记录已脱敏的 execution-error。
        action.onResult("failed", "execution-error");
      }
    }
    this.running = false;
  }
}
