// TouchDeck 控制台（React + Tailwind）：本机面板启停 + P2P 远程连接 + 状态总览。
// 视觉 1:1 复刻原生 HTML 版（暗色卡片风），交互语义不变。
import React, { useCallback, useEffect, useRef, useState } from "react";

interface PanelStatus { panelRunning: boolean; panelDisabled: boolean; }
interface P2PStatus { phase?: string; code?: string; pairingKey?: string; hostFingerprint?: string; peers?: number; state?: string; error?: string; attempt?: number; }

// P2P 运行态（按钮显示「关闭连接」）；不在列表里的 phase 都是可开启态
const P2P_ACTIVE = ["connecting", "signal-ok", "room", "peer-joined", "peer-state", "connected", "peer-error", "reconnecting"];

const card = "bg-[#222228] border border-[#33333a] rounded-xl px-4 py-3.5 mb-3";
const btnMain = "bg-[#2f6fed] hover:bg-[#3d7dff] text-white rounded-lg px-5 py-2.5 text-sm font-semibold disabled:opacity-40 disabled:cursor-default cursor-pointer";

function Dot({ ok }: { ok: boolean }) {
  return <div className={`w-[9px] h-[9px] rounded-full flex-none ${ok ? "bg-[#4ade80] dot-glow" : "bg-[#ef4444]"}`} />;
}

export default function App() {
  const [panel, setPanel] = useState<PanelStatus>({ panelRunning: false, panelDisabled: false });
  const [p2p, setP2p] = useState<P2PStatus>({ phase: "idle" });
  const [scene, setScene] = useState("场景 默认");
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [panelBusy, setPanelBusy] = useState(false);
  const [p2pBusy, setP2pBusy] = useState(false);
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
    // 隐藏进托盘后暂停轮询，回前台立即补一次
    const timer = setInterval(() => { if (!document.hidden) refresh(); }, 4000);
    const onVis = () => { if (!document.hidden) refresh(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [refresh, toast]);

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
    case "room": p2pLabel = "等待手机加入（30 分钟有效）"; break;
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

  return (
    <div className="p-[18px]">
      <h1 className="text-[19px] mb-0.5">TouchDeck 控制台</h1>
      <div className="text-[#888] text-xs mb-3.5">本机面板 + P2P 远程连接的统一入口</div>

      {/* 顶部状态总览 */}
      <div className="flex gap-[18px] bg-[#1e1e24] border border-[#33333a] rounded-[10px] px-3.5 py-2.5 mb-3.5">
        <div className="flex items-center gap-[7px] text-[13px] text-[#ccc]">
          <Dot ok={p2pConnected} /><span>P2P {p2pConnected ? "已直连" : p2pActive ? "连接中" : "未开启"}</span>
        </div>
        <div className="flex items-center gap-[7px] text-[13px] text-[#ccc]">
          <Dot ok={panel.panelRunning} /><span>面板 {panel.panelRunning ? "运行中" : "已关闭"}</span>
        </div>
        <div className="flex items-center text-[13px]"><span className="text-[#888]">{scene}</span></div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold mb-1">本机面板</h2>
        <div className="text-[#888] text-xs mb-2.5 leading-relaxed">悬浮球快捷键面板（键鼠交互：点球或按住 Tab 展开）。远程端（手机、平板）在用时，可关闭本机面板避免重复。</div>
        <div className="flex items-center gap-2.5">
          <span className="text-[#ccc] flex-1 text-[13px]">{panel.panelRunning ? "运行中" : panel.panelDisabled ? "已关闭" : "未运行"}</span>
          <button className={btnMain} disabled={panelBusy} onClick={togglePanel}>
            {panel.panelRunning ? "关闭面板" : "开启面板"}
          </button>
        </div>
      </div>

      <div className={card}>
        <h2 className="text-sm font-semibold mb-1">远程连接（P2P 直连）</h2>
        <div className="text-[#888] text-xs mb-2.5 leading-relaxed">手机 App 输入房间码即可直连本机，不经过公网转发。</div>
        <div className="flex items-center gap-2.5 mb-2">
          <Dot ok={p2pDotOk} />
          <span className="text-[#ccc] flex-1 text-[13px]">{p2pLabel}</span>
          <button className={btnMain} disabled={p2pBusy} onClick={toggleP2p}>
            {p2pActive ? "关闭连接" : "开启连接"}
          </button>
        </div>
        {p2p.code && (
          <div className="flex items-center gap-2 px-2.5 py-[7px] bg-[#1b1b20] border border-[#33333a] hover:border-[#4a4a55] rounded-lg mb-1.5 cursor-pointer"
               title="点击复制房间码" onClick={copyRoom}>
            <span className="text-[#888] text-xs w-16 flex-none">房间码</span>
            <span className="font-mono text-xs text-[#9ac8ff] break-all flex-1">{p2p.code}</span>
            <span className={`text-[#4ade80] text-xs flex-none ${copied ? "" : "hidden"}`}>已复制</span>
          </div>
        )}
        {p2p.pairingKey && <div className="text-[#f0c674] text-xs mt-1">首次配对密钥：<span className="font-mono select-text">{p2p.pairingKey}</span>（5 分钟内仅可使用一次）</div>}
        {p2p.hostFingerprint && <div className="text-[#888] text-xs mt-1">主机身份指纹：<span className="font-mono">{p2p.hostFingerprint}</span></div>}
        <div className="text-[#888] text-xs">首次连接需在手机输入房间码和配对密钥；已配对设备可用续连凭据恢复连接。</div>
      </div>

      {/* toast */}
      <div className={`fixed left-1/2 bottom-6 -translate-x-1/2 bg-[rgba(40,40,46,.95)] text-white text-[13px] px-3.5 py-2 rounded-[10px] transition-opacity duration-200 pointer-events-none z-10 ${toastMsg ? "opacity-100" : "opacity-0"}`}>
        {toastMsg}
      </div>
    </div>
  );
}
