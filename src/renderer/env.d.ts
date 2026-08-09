// 渲染层全局类型：preload 暴露的 window.touchdeck（IPC 契约，迁移冻结面）
export interface TouchdeckApi {
  getConfig(): Promise<any>;
  getIcon(name: string): Promise<{ kind: string; data: string } | null>;
  press(id: string): Promise<{ ok: boolean; reason?: string; queued?: boolean }>;
  startDrag(): void;
  stopDrag(): void;
  onDragEnded(cb: () => void): void;
  debugShot(): Promise<void>;
  closeMenu(): void;
  toggleMenu(): void;
  select(id: string): void;
  dismiss(): void;
  onMenuInit(cb: (init: any) => void): void;
  onMenuConfirm(cb: () => void): void;
  onMenuReload(cb: () => void): void;
  consoleStatus(): Promise<{ panelRunning: boolean; panelDisabled: boolean }>;
  consoleTogglePanel(): Promise<{ running: boolean }>;
  peerStart(signalUrl?: string): Promise<{ ok: boolean }>;
  peerStop(): Promise<{ ok: boolean }>;
  peerStatusGet(): Promise<any>;
  peerReady(): void;
  onPeerStart(cb: (url: string | null) => void): void;
  onPeerStop(cb: () => void): void;
  peerStatus(s: unknown): void;
  peerAction(clientId: string, payload: unknown): void;
  onPeerStatus(cb: (s: any) => void): void;
  onPanelStatus(cb: (s: { panelRunning: boolean; panelDisabled: boolean }) => void): void;
  onPeerPressFailed(cb: (id: string) => void): void;
  onActionFeedback(cb: (fb: any) => void): void;
  onScenarioChanged(cb: (s: { scenario: string | null; foreground: string | null }) => void): void;
  onConfigReloaded(cb: (s: { errors: string[] }) => void): void;
  onPeerBroadcast(cb: (payload: any) => void): void;
  peerChannelOpen(): void;
  onPeerActionResult(cb: (payload: any) => void): void;
}

declare global {
  interface Window {
    touchdeck: TouchdeckApi;
  }
}
