// TouchDeck 控制台：深色指挥中心风格，自绘标题栏 + 宽屏双栏工作区。
import React, { useCallback, useEffect, useRef, useState } from "react";
import appIcon from "../../assets/app-icon.png";
import activityIcon from "lucide-static/icons/activity.svg";
import commandIcon from "lucide-static/icons/command.svg";
import maximizeIcon from "lucide-static/icons/square.svg";
import minimizeIcon from "lucide-static/icons/minus.svg";
import monitorIcon from "lucide-static/icons/monitor.svg";
import phoneIcon from "lucide-static/icons/smartphone.svg";
import resetIcon from "lucide-static/icons/rotate-ccw.svg";
import saveIcon from "lucide-static/icons/save.svg";
import xIcon from "lucide-static/icons/x.svg";

interface PanelStatus { panelRunning: boolean; panelDisabled: boolean; }
interface P2PStatus { phase?: string; code?: string; pairingKey?: string; pairingPending?: boolean; pairingError?: string; hostFingerprint?: string; peers?: number; state?: string; error?: string; attempt?: number; revokingDevices?: boolean; revokeError?: string; devicesRevoked?: boolean; }
type ActionId = "voice" | "esc" | "enter" | "newline" | "paste" | "command-menu" | "clear-input" | "delete-word" | "slash";
interface Binding { presetId: string; keys: Record<string, boolean | string>; triggerMode: "tap" | "hold"; }
interface BindingsData { schemaVersion: 1; bindings: Record<ActionId, Binding>; }
interface Preset extends Binding { label: string; description: string; }

// P2P 运行态（按钮显示「关闭连接」）；不在列表里的 phase 都是可开启态
const P2P_ACTIVE = ["connecting", "signal-ok", "room", "peer-joined", "peer-state", "connected", "peer-error", "reconnecting"];

const btnMain = "button button-primary";
const btnDanger = "button button-danger";

const pairingErrorText: Record<string, string> = {
  "signal-unavailable": "信令尚未连接",
  "host-auth-required": "主机尚未完成鉴权",
  "host-auth-failed": "主机鉴权失败",
  "room-expired": "房间已过期",
  timeout: "服务端响应超时",
  "invalid-response": "服务端响应无效",
  "request-failed": "服务端拒绝请求",
};

function Dot({ ok }: { ok: boolean }) {
  return <span className={`status-dot ${ok ? "is-online" : ""}`} />;
}

function WindowIcon({ kind }: { kind: "minimize" | "maximize" | "close" }) {
  const src = kind === "minimize" ? minimizeIcon : kind === "maximize" ? maximizeIcon : xIcon;
  return <img src={src} alt="" />;
}

function shortcutParts(keys: Binding["keys"]): string[] {
  const parts = [keys.ctrl && "Ctrl", keys.shift && "Shift", keys.alt && "Alt", keys.win && "Win"].filter(Boolean) as string[];
  if (typeof keys.key === "string" && keys.key) {
    const aliases: Record<string, string> = { escape: "Esc", enter: "Enter", backspace: "Backspace", space: "Space", tab: "Tab" };
    parts.push(aliases[keys.key.toLowerCase()] || keys.key.toUpperCase());
  }
  return parts;
}

// 快捷键渲染成键帽组合，比纯文本「Ctrl + Alt + K」更可扫读
function Keycaps({ keys }: { keys: Binding["keys"] }) {
  const parts = shortcutParts(keys);
  if (!parts.length) return <span className="kbd-empty">未设置</span>;
  return <span className="keycaps">{parts.map((part, i) => <kbd key={i}>{part}</kbd>)}</span>;
}

export default function App() {
  const [panel, setPanel] = useState<PanelStatus>({ panelRunning: false, panelDisabled: false });
  const [p2p, setP2p] = useState<P2PStatus>({ phase: "idle" });
  const [scene, setScene] = useState("场景 默认");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);
  const [p2pBusy, setP2pBusy] = useState(false);
  const [bindings, setBindings] = useState<BindingsData | null>(null);
  const [presets, setPresets] = useState<Record<ActionId, Preset[]> | null>(null);
  const [bindingBusy, setBindingBusy] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((text: string, ms = 1500) => {
    setToastMsg(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), ms);
  }, []);

  const refresh = useCallback(async () => {
    setPanel(await window.touchdeck.consoleStatus());
    setP2p(await window.touchdeck.peerStatusGet());
  }, []);

  const refreshBindings = useCallback(async () => {
    const data = await window.touchdeck.actionBindingsGet();
    setBindings(data.bindings);
    setPresets(data.presets);
  }, []);

  useEffect(() => {
    const api = window.touchdeck;
    api.onPeerStatus(setP2p);
    api.onPanelStatus(setPanel);
    api.onPeerPressFailed((id) => toast("远程按键注入失败：" + id));
    // 宏引擎反馈：拦截与失败必须可见（成功不打扰）；配置错误启动即提示
    api.onActionFeedback((fb) => {
      if (fb.ok) return;
      const src = ({ local: "本机", menu: "菜单", peer: "远程" } as Record<string, string>)[fb.source] || fb.source;
      toast(`${src}动作「${fb.id}」${fb.blocked ? "已拦截" : "失败"}：${fb.reason}`, 2600);
    });
    api.onScenarioChanged((s) => setScene("场景 " + (s.scenario || "默认") + (s.foreground ? " · " + s.foreground : "")));
    // 配置热重载：有错报第一条，无错轻提示；场景行顺带刷新
    api.onConfigReloaded((s) => {
      if (s.errors && s.errors.length) toast(`配置错误 ${s.errors.length} 条：${s.errors[0]}`, 4000);
      else toast("配置已热重载", 1500);
      api.getConfig().then((cfg) => setScene("场景 " + (cfg.activeScenario || "默认") + (cfg.foreground ? " · " + cfg.foreground : "")));
    });
    // 初始场景/前台 + 配置错误提示
    api.getConfig().then((cfg) => {
      setScene("场景 " + (cfg.activeScenario || "默认") + (cfg.foreground ? " · " + cfg.foreground : ""));
      if (cfg.configErrors && cfg.configErrors.length) toast(`配置错误 ${cfg.configErrors.length} 条：${cfg.configErrors[0]}`, 4000);
    });
    refresh();
    refreshBindings();
    // 隐藏进托盘后暂停轮询，回前台立即补一次
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 4000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh, refreshBindings, toast]);

  const updateBinding = (actionId: ActionId, binding: Binding) => {
    setBindings((current) => current ? { ...current, bindings: { ...current.bindings, [actionId]: binding } } : current);
  };

  const choosePreset = (actionId: ActionId, presetId: string) => {
    const current = bindings?.bindings[actionId];
    if (!current) return;
    const preset = presets?.[actionId].find((item) => item.presetId === presetId);
    updateBinding(actionId, preset
      ? { presetId: preset.presetId, keys: { ...preset.keys }, triggerMode: preset.triggerMode }
      : { ...current, presetId: "custom" });
  };

  const saveBindings = async (confirmConflicts = false) => {
    if (!bindings) return;
    setBindingBusy(true);
    try {
      const result = await window.touchdeck.actionBindingsSave(bindings, confirmConflicts);
      if (!result.ok && result.reason === "binding-conflict") {
        if (window.confirm("存在重复快捷键，可能导致动作含义不明确。仍要保存吗？")) return await saveBindings(true);
        return;
      }
      if (!result.ok) throw new Error(result.reason || "unknown");
      setBindings(result.bindings);
      toast("动作绑定已保存并同步到 Android");
    } catch (e) { toast("保存失败：" + e, 2600); }
    finally { setBindingBusy(false); }
  };

  const resetBinding = async (actionId: ActionId) => {
    const result = await window.touchdeck.actionBindingReset(actionId);
    if (result.ok) { setBindings(result.bindings); toast("已恢复推荐值"); }
  };

  const resetAllBindings = async () => {
    if (!window.confirm("恢复全部推荐绑定？")) return;
    const result = await window.touchdeck.actionBindingsResetAll();
    if (result.ok) { setBindings(result.bindings); toast("已恢复全部推荐值"); }
  };

  const togglePanel = async () => {
    setPanelBusy(true);
    try {
      await window.touchdeck.consoleTogglePanel();
      await refresh();
    } catch (e) {
      toast("面板操作失败：" + e);
    } finally {
      setPanelBusy(false);
    }
  };

  const toggleP2p = async () => {
    setP2pBusy(true);
    try {
      const ps = await window.touchdeck.peerStatusGet();
      if (ps && P2P_ACTIVE.includes(ps.phase)) await window.touchdeck.peerStop();
      else await window.touchdeck.peerStart();
      await refresh();
    } catch (e) {
      toast("P2P 操作失败：" + e);
    } finally {
      setP2pBusy(false);
    }
  };

  const copyRoom = async () => {
    try {
      await navigator.clipboard.writeText(p2p.code || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      toast("复制失败");
    }
  };

  const copyPairKey = async () => {
    try {
      await navigator.clipboard.writeText(p2p.pairingKey || "");
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 1200);
    } catch {
      toast("复制失败");
    }
  };

  const createPairKey = async () => {
    try {
      const result = await window.touchdeck.peerCreatePairKey();
      if (!result.ok) toast("当前连接不可用，请重新开启远程连接");
    } catch (e) {
      toast("生成配对密钥失败：" + e);
    }
  };

  const revokeDevices = async () => {
    if (!window.confirm("忘记全部已配对设备？现有手机和平板会立即断开，之后必须使用新的配对密钥重新登记。")) return;
    try {
      const result = await window.touchdeck.peerRevokeDevices();
      if (!result.ok) toast("当前连接不可用，请重新开启远程连接");
    } catch (e) {
      toast("撤销设备失败：" + e);
    }
  };

  // P2P 状态行渲染（与原 HTML 版逐分支一致）
  const p2pActive = P2P_ACTIVE.includes(p2p.phase || "");
  const p2pConnected = p2p.phase === "connected";
  const peersN = p2p.peers || 0;
  const peersTxt = peersN > 0 ? `（${peersN} 台设备）` : "";
  const stateTxt: Record<string, string> = { new: "建立中", connecting: "建立中", connected: "已直连", disconnected: "抖动断开，恢复中…", failed: "连接失败", closed: "已关闭" };
  let p2pLabel = "未开启";
  let p2pDotOk = false;
  switch (p2p.phase) {
    case "connecting": p2pLabel = "连接信令中…"; break;
    case "signal-ok": p2pLabel = "信令已连接，正在创建房间…"; break;
    case "room": p2pLabel = "等待设备加入"; break;
    case "peer-joined": p2pLabel = "手机已加入，正在建立直连…"; break;
    case "peer-state":
      // ICE/连接状态变化：按实际状态显示，不再打回「未开启」谎报
      p2pDotOk = p2p.state === "connected";
      p2pLabel = "直连状态：" + (stateTxt[p2p.state || ""] || p2p.state || "未知") + peersTxt;
      break;
    case "connected":
      p2pDotOk = true;
      p2pLabel = peersN > 1 ? `已直连（${peersN} 台设备）` : "已直连（按键不走公网转发）";
      break;
    case "peer-error": p2pLabel = "协商出错：" + (p2p.error || "未知"); break;
    case "reconnecting": p2pLabel = "信令断线，自动重连中…" + (p2p.attempt ? `（第 ${p2p.attempt} 次）` : ""); break;
    case "room-expired": p2pLabel = "房间已过期，请重新开启"; break;
    case "signal-failed": p2pLabel = "信令重连失败（" + (p2p.error || "已达上限") + "）"; break;
  }

  const actions: ActionId[] = ["voice", "esc", "enter", "newline", "paste", "command-menu", "clear-input", "delete-word", "slash"];
  const names: Record<ActionId, string> = { voice: "语音", esc: "中断", enter: "发送", newline: "换行", paste: "粘贴", "command-menu": "命令菜单", "clear-input": "清空输入", "delete-word": "按词删除", slash: "/ 命令" };
  const windowControl = (action: "minimize" | "maximize" | "close") => window.touchdeck.consoleWindowControl(action);

  return <div className="app-shell">
    <header className="titlebar" onDoubleClick={() => windowControl("maximize")}>
      <div className="brand">
        <img src={appIcon} alt="" />
        <span>TouchDeck</span>
        <span className="brand-caption">控制台</span>
      </div>
      <div className="window-controls" onDoubleClick={(e) => e.stopPropagation()}>
        {(["minimize", "maximize", "close"] as const).map((kind) => (
          <button key={kind} className={`window-button ${kind === "close" ? "close" : ""}`} aria-label={kind} onClick={() => windowControl(kind)}>
            <WindowIcon kind={kind} />
          </button>
        ))}
      </div>
    </header>

    <main className="workspace">
      <div className="page-head">
        <div className="page-title">
          <h1>控制台</h1>
          <p>悬浮菜单与手机远程触控的总开关</p>
        </div>
        <div className="status-chips">
          <span className="chip"><Dot ok={panel.panelRunning} />悬浮菜单 {panel.panelRunning ? "运行中" : "未运行"}</span>
          <span className="chip"><Dot ok={p2pConnected} />{p2pConnected ? `${peersN || 1} 台设备在线` : p2pActive ? "连接中" : "未连接"}</span>
          <span className="chip"><img src={activityIcon} alt="" />{scene.replace(/^场景\s*/, "")}</span>
        </div>
      </div>

      <div className="dashboard-grid">
        <section className="surface actions-card">
          <div className="section-heading actions-heading">
            <div className="heading-with-icon">
              <span className="icon-tile"><img src={commandIcon} alt="" /></span>
              <h2>快捷动作</h2>
            </div>
            <span className="count-badge">{actions.length} 个</span>
          </div>
          {bindings && presets && <>
            <div className="action-grid">
              {actions.map((actionId) => {
                const binding = bindings.bindings[actionId];
                return <article key={actionId} className="action-item">
                  <div className="action-title">
                    <div>
                      <strong>{names[actionId]}</strong>
                      <Keycaps keys={binding.keys} />
                    </div>
                    <button onClick={() => resetBinding(actionId)}>恢复</button>
                  </div>
                  <div className="select-row">
                    <select value={binding.presetId} onChange={(e) => choosePreset(actionId, e.target.value)}>
                      {presets[actionId].map((preset) => <option key={preset.presetId} value={preset.presetId}>{preset.label}</option>)}
                      <option value="custom">自定义</option>
                    </select>
                    <select value={binding.triggerMode} disabled={binding.presetId !== "custom"} onChange={(e) => updateBinding(actionId, { ...binding, triggerMode: e.target.value as "tap" | "hold" })}>
                      <option value="tap">单击触发</option>
                      <option value="hold">按住保持</option>
                    </select>
                  </div>
                  {binding.presetId === "custom" && <div className="key-editor">
                    {(["ctrl", "shift", "alt", "win"] as const).map((mod) => (
                      <label key={mod}>
                        <input type="checkbox" checked={binding.keys[mod] === true} onChange={(e) => updateBinding(actionId, { ...binding, keys: { ...binding.keys, [mod]: e.target.checked } })} />
                        {mod === "win" ? "Win" : mod[0].toUpperCase() + mod.slice(1)}
                      </label>
                    ))}
                    <select value={typeof binding.keys.key === "string" ? binding.keys.key : ""} onChange={(e) => updateBinding(actionId, { ...binding, keys: { ...binding.keys, key: e.target.value || undefined as any } })}>
                      <option value="">无主键</option>
                      {["escape", "tab", "enter", "backspace", "space", ..."abcdefghijklmnopqrstuvwxyz"].map((key) => <option key={key} value={key}>{key}</option>)}
                    </select>
                  </div>}
                </article>;
              })}
            </div>
            <footer className="actions-footer">
              <div>
                <button className="button button-quiet" onClick={resetAllBindings}><img src={resetIcon} alt="" />恢复默认</button>
                <button className={btnMain} disabled={bindingBusy} onClick={() => saveBindings()}><img src={saveIcon} alt="" />{bindingBusy ? "保存中…" : "保存更改"}</button>
              </div>
            </footer>
          </>}
        </section>

        <aside className="side-stack">
          <section className="surface quick-card">
            <div className="section-heading">
              <div className="heading-with-icon">
                <span className="icon-tile"><img src={monitorIcon} alt="" /></span>
                <h2>悬浮菜单</h2>
              </div>
              <span className={`state-pill ${panel.panelRunning ? "active" : ""}`}>{panel.panelRunning ? "运行中" : panel.panelDisabled ? "已关闭" : "未运行"}</span>
            </div>
            <button className={btnMain} disabled={panelBusy} onClick={togglePanel}>{panel.panelRunning ? "关闭" : "开启"}</button>
          </section>

          <section className="surface connection-card">
            <div className="section-heading">
              <div className="heading-with-icon">
                <span className="icon-tile"><img src={phoneIcon} alt="" /></span>
                <h2>手机直连</h2>
              </div>
              <Dot ok={p2pDotOk} />
            </div>
            <p className="connection-state">{p2pLabel}</p>
            <button className={btnMain} disabled={p2pBusy} onClick={toggleP2p}>{p2pActive ? "关闭" : "开启"}</button>
            <div className="connection-details">
              {p2p.code && <button className="copy-row" title="点击复制房间码" onClick={copyRoom}>
                <span>房间码</span><code>{p2p.code}</code><em>{copied ? "已复制" : "复制"}</em>
              </button>}
              {p2p.pairingKey && <button className="copy-row" title="点击复制配对密钥" onClick={copyPairKey}>
                <span>配对密钥</span><code>{p2p.pairingKey}</code><em>{copiedKey ? "已复制" : "复制"}</em>
              </button>}
              {p2p.code && !p2p.pairingKey && <div className="inline-action">
                <small>新设备需要新密钥。</small>
                <button className="text-button" disabled={p2p.pairingPending} onClick={createPairKey}>{p2p.pairingPending ? "正在生成…" : "添加设备"}</button>
              </div>}
              {p2p.pairingError && <small className="error">配对密钥生成失败：{pairingErrorText[p2p.pairingError] || p2p.pairingError}</small>}
              {p2p.hostFingerprint && <small>主机身份指纹：<code>{p2p.hostFingerprint}</code></small>}
              {p2p.code && <div className="revoke-row">
                <small>取消全部设备授权</small>
                <button className={btnDanger} disabled={p2p.revokingDevices} onClick={revokeDevices}>{p2p.revokingDevices ? "正在撤销…" : "忘记全部设备"}</button>
              </div>}
              {p2p.devicesRevoked && <small className="success">已撤销全部设备，请重新配对。</small>}
              {p2p.revokeError && <small className="error">撤销失败：{pairingErrorText[p2p.revokeError] || p2p.revokeError}</small>}
            </div>
          </section>
        </aside>
      </div>
    </main>
    <div className={`toast ${toastMsg ? "visible" : ""}`}>{toastMsg}</div>
  </div>;
}
