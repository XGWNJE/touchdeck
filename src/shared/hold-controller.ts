export type HoldReleaseReason = "end" | "disconnect" | "host-stop" | "shutdown" | "watchdog";

export interface HoldIdentity {
  clientId: string;
  interactionId: string;
  buttonId: string;
}

export interface HoldResult {
  status: "holding" | "released" | "failed";
  reason?: string;
}

export interface HoldControllerOptions {
  begin: (hold: HoldIdentity) => Promise<void>;
  release: (hold: HoldIdentity, reason: HoldReleaseReason) => Promise<void>;
  watchdogMs?: number;
  tombstoneLimit?: number;
  onAutomaticRelease?: (hold: HoldIdentity, result: HoldResult, reason: HoldReleaseReason) => void;
}

interface Tombstone extends HoldIdentity {}

/**
 * 单活动会话的保持控制器。它不依赖 Electron 或具体键盘实现，调用方负责在
 * begin/release 适配器中按下和释放完整组合键。
 */
export class HoldController {
  private active: HoldIdentity | null = null;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private readonly tombstones = new Map<string, Tombstone>();
  private operation: Promise<void> = Promise.resolve();

  constructor(private readonly options: HoldControllerOptions) {}

  get activeHold(): Readonly<HoldIdentity> | null {
    return this.active;
  }

  begin(hold: HoldIdentity): Promise<HoldResult> {
    return this.serialize(() => this.beginNow(hold));
  }

  end(hold: HoldIdentity): Promise<HoldResult> {
    return this.serialize(() => this.endNow(hold));
  }

  releaseClient(clientId: string, reason: HoldReleaseReason = "disconnect"): Promise<HoldResult | null> {
    return this.serialize(async () => {
      if (!this.active || this.active.clientId !== clientId) return null;
      return this.releaseActive(reason);
    });
  }

  releaseAll(reason: HoldReleaseReason = "host-stop"): Promise<HoldResult | null> {
    return this.serialize(async () => this.active ? this.releaseActive(reason) : null);
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  private async beginNow(hold: HoldIdentity): Promise<HoldResult> {
    const ended = this.tombstones.get(hold.interactionId);
    if (ended) {
      if (!this.sameOwner(ended, hold)) return { status: "failed", reason: "interaction-owner-mismatch" };
      if (ended.buttonId !== hold.buttonId) return { status: "failed", reason: "interaction-conflict" };
      return { status: "released" };
    }
    if (this.active) {
      if (this.active.interactionId !== hold.interactionId) return { status: "failed", reason: "hold-busy" };
      if (!this.sameOwner(this.active, hold)) return { status: "failed", reason: "interaction-owner-mismatch" };
      if (this.active.buttonId !== hold.buttonId) return { status: "failed", reason: "interaction-conflict" };
      return { status: "holding" };
    }
    try {
      await this.options.begin(hold);
    } catch {
      return { status: "failed", reason: "begin-error" };
    }
    this.active = { ...hold };
    const watchdogMs = this.options.watchdogMs ?? 60_000;
    this.watchdog = setTimeout(() => {
      void this.serialize(async () => {
        if (!this.active || this.active.interactionId !== hold.interactionId) return;
        const result = await this.releaseActive("watchdog");
        this.options.onAutomaticRelease?.(hold, result, "watchdog");
      });
    }, watchdogMs);
    return { status: "holding" };
  }

  private async endNow(hold: HoldIdentity): Promise<HoldResult> {
    if (this.active?.interactionId === hold.interactionId) {
      if (!this.sameOwner(this.active, hold)) return { status: "failed", reason: "interaction-owner-mismatch" };
      if (this.active.buttonId !== hold.buttonId) return { status: "failed", reason: "interaction-conflict" };
      return this.releaseActive("end");
    }
    const ended = this.tombstones.get(hold.interactionId);
    if (!ended) return { status: "failed", reason: "unknown-interaction" };
    if (!this.sameOwner(ended, hold)) return { status: "failed", reason: "interaction-owner-mismatch" };
    if (ended.buttonId !== hold.buttonId) return { status: "failed", reason: "interaction-conflict" };
    return { status: "released" };
  }

  private async releaseActive(reason: HoldReleaseReason): Promise<HoldResult> {
    const hold = this.active!;
    this.clearWatchdog();
    let result: HoldResult = { status: "released" };
    try {
      await this.options.release(hold, reason);
    } catch {
      result = { status: "failed", reason: "release-error" };
    } finally {
      this.active = null;
      this.rememberReleased(hold);
    }
    return result;
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  private rememberReleased(hold: HoldIdentity): void {
    this.tombstones.delete(hold.interactionId);
    this.tombstones.set(hold.interactionId, { ...hold });
    const limit = this.options.tombstoneLimit ?? 256;
    while (this.tombstones.size > limit) this.tombstones.delete(this.tombstones.keys().next().value!);
  }

  private sameOwner(a: HoldIdentity, b: HoldIdentity): boolean {
    return a.clientId === b.clientId;
  }
}
