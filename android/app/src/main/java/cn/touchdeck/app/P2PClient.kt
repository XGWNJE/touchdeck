package cn.touchdeck.app

import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SessionDescription
import org.webrtc.DataChannel.Init as DcInit
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONArray
import org.json.JSONObject
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * host 下发的动态按钮（DataChannel "buttons" 消息，连接建立与场景切换时推送）。
 * 字段全部可空兜底，缺字段按空串/false 处理，不崩。
 */
data class PanelButton(
    val id: String,
    val icon: String,
    val label: String,
    val sub: String,
    val group: String,
    val confirm: Boolean,
    val aux: Boolean
)

data class RemoteActionResult(val requestId: String, val status: String, val reason: String)
enum class SendOutcome { QUEUED, DISCONNECTED }

/**
 * P2P 全局状态：MainActivity 控制连接，BubbleService 按键时读取。
 * 线程：信令回调在 WebSocket 线程，状态更新走主线程（listener 内 runOnUiThread 由调用方处理）。
 */
object P2PState {
    @Volatile
    var appContext: android.content.Context? = null
    @Volatile
    var client: P2PClient? = null
    @Volatile
    var status: String = "idle"          // idle/connecting/ready/connected/reconnecting/host-gone/error/closed
    @Volatile
    var roomCode: String = ""
    @Volatile
    var hostFingerprint: String = ""
    @Volatile
    var errorReason: String = ""
    var listener: ((String) -> Unit)? = null
    var actionListener: ((RemoteActionResult) -> Unit)? = null

    // host 下发的动态按钮集（数组顺序即排布顺序，aux 常驻键在前）；null = 用离线 panel.json
    @Volatile
    var dynamicButtons: List<PanelButton>? = null

    fun start(signalUrl: String, code: String, pairKey: String, deviceKey: String?, onDeviceKey: (String) -> Unit, onHostFingerprint: (String) -> Unit, onOpen: () -> Unit) {
        stop()
        roomCode = code
        errorReason = ""
        val c = P2PClient(
            signalUrl, code, pairKey, deviceKey, onDeviceKey, onHostFingerprint,
            onState = { s ->
                status = s
                listener?.invoke(s)
            },
            onChannelOpen = onOpen,
            ctx = appContext
        )
        client = c
        c.start()
    }

    fun stop() {
        client?.teardown()
        client = null
        status = "idle"
        hostFingerprint = ""
        errorReason = ""
        dynamicButtons = null // 断开即清空动态按钮集，菜单回落离线 panel.json
        listener?.invoke("idle")
    }

    /** 网络恢复等外部事件触发立即重连（内部判状态，不重复连） */
    fun reconnectNow() {
        client?.reconnectNow()
    }

    fun send(id: String): SendOutcome = client?.send(id) ?: SendOutcome.DISCONNECTED

    // 只由 debug source-set 的 ADB 测试接收器调用；Release APK 不注册该接收器。
    fun sendWithRequestIdForTest(id: String, requestId: String): SendOutcome =
        client?.sendWithRequestId(id, requestId) ?: SendOutcome.DISCONNECTED
}

/**
 * P2P 客户端（安卓 = client 角色）。健壮性（2026-08-05）：
 * - 断线自动重连：信令 WS 断开/ICE 失败/通道半开 → 指数退避重 join 原房间码（host reclaim 期间房间保留）。
 * - DataChannel 心跳：每 5s ping，20s 无 pong 判半开 → 重连（旧版半开只能靠发送失败被动发现）。
 * - host 闪断：收到 host-gone 不自毁 WebRTC，等待 host-back（服务端 90s 宽限期兜底）。
 * - 网络切换：ConnectivityManager 回调，网络恢复立即重连。
 * - 终态错误（房间不存在/已满/过期）不重试，报 error 交用户处理。
 */
class P2PClient(
    private val signalUrl: String,
    private val roomCode: String,
    private val pairKey: String,
    private var deviceKey: String?,
    private val onDeviceKey: (String) -> Unit,
    private val onHostFingerprint: (String) -> Unit,
    private val onState: (String) -> Unit,      // connecting/ready/connected/reconnecting/host-gone/error/closed
    private val onChannelOpen: () -> Unit,
    ctx: android.content.Context?
) {
    companion object {
        private const val TAG = "TouchDeckP2P"
        private const val MAX_ATTEMPTS = 8
        private const val PING_INTERVAL_S = 5L
        private const val PONG_TIMEOUT_MS = 20000L
        private val DC_INIT = DcInit().apply { ordered = true; maxRetransmits = -1 }
    }

    private val appContext: android.content.Context = ctx
        ?: throw IllegalStateException("P2PState.appContext must be set before P2P start")

    private var ws: WebSocketClient? = null
    private var pc: PeerConnection? = null
    private var factory: PeerConnectionFactory? = null
    private var channel: DataChannel? = null
    private var turn: JSONObject? = null
    @Volatile
    private var closed = false
    @Volatile
    private var attempts = 0
    @Volatile
    private var lastPong = 0L
    @Volatile
    private var channelOpen = false
    // 重连任务内的主动 closeWs 会触发 onClose，必须识别并吞掉，
    // 否则 onClose 又排一次重连，健康连接被反复误拆（2026-08-05 真机实证 churn 环）
    @Volatile
    private var intentionalWsClose = false

    private val exec = Executors.newSingleThreadScheduledExecutor()
    private var reconnectFuture: ScheduledFuture<*>? = null
    private var pingFuture: ScheduledFuture<*>? = null
    private var watchdogFuture: ScheduledFuture<*>? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private data class PendingAction(val buttonId: String, var attempts: Int = 0)
    private val pendingActions = ConcurrentHashMap<String, PendingAction>()

    fun start() {
        closed = false
        registerNetworkCallback()
        connectWs()
    }

    // ===== 信令 WebSocket =====

    private fun connectWs() {
        if (closed) return
        onState(if (attempts == 0) "connecting" else "reconnecting")
        try {
            ws = object : WebSocketClient(URI(signalUrl.trimEnd('/'))) {
                override fun onOpen(handshake: ServerHandshake?) {
                    val join = JSONObject().put("type", "join-room").put("code", roomCode)
                    if (deviceKey.isNullOrBlank()) join.put("pairKey", pairKey) else join.put("deviceKey", deviceKey)
                    send(join.toString())
                }

                override fun onMessage(message: String?) {
                    try {
                        handleSignal(JSONObject(message ?: "{}"))
                    } catch (e: Exception) {
                        Log.d(TAG, "signal parse error: ${e.message}")
                    }
                }

                override fun onClose(code: Int, reason: String?, remote: Boolean) {
                    Log.d(TAG, "ws closed code=$code reason=$reason")
                    if (intentionalWsClose) { intentionalWsClose = false; return }
                    if (!closed) scheduleReconnect()
                }

                override fun onError(ex: Exception?) {
                    Log.d(TAG, "ws error: ${ex?.message}")
                    try { ws?.close() } catch (_: Exception) {}
                }
            }
            ws?.connect()
        } catch (e: Exception) {
            scheduleReconnect()
        }
    }

    private fun handleSignal(msg: JSONObject) {
        when (msg.optString("type")) {
            "room" -> {
                P2PState.errorReason = ""
                msg.optString("deviceKey").takeIf { it.isNotBlank() }?.let { key -> deviceKey = key; onDeviceKey(key) }
                msg.optString("hostFingerprint").takeIf { it.matches(Regex("[A-F0-9]{16}")) }?.let { value ->
                    P2PState.hostFingerprint = value
                    onHostFingerprint(value)
                }
                turn = msg.optJSONObject("turn")
                attempts = 0 // 进房才算连上，重置退避
                onState("ready")
                setupPeer()
            }
            "signal" -> {
                if (pc == null) setupPeer()
                handlePeerSignal(msg.optJSONObject("data") ?: JSONObject())
            }
            "host-gone" -> {
                // host 信令闪断：不自毁 WebRTC（服务端宽限期保留房间），等 host-back
                Log.d(TAG, "host gone, waiting for reclaim")
                // 已发出的动作不能继续显示为可等待状态：Host 已不在，无法保证其会执行或回 ACK。
                // WebRTC 连接本身仍保留，Host reclaim 后可继续使用；仅结束当前这批待确认动作。
                finishAllPending("disconnected", "host-gone")
                onState("host-gone")
            }
            "host-back" -> {
                Log.d(TAG, "host back")
                onState(if (channelOpen) "connected" else "ready")
            }
            "peer-left" -> {
                // 房间被删（host 主动停止/宽限期满/过期）：重 join 无意义，进终态
                Log.d(TAG, "room closed by host/server")
                teardown()
                onState("closed")
            }
            "error" -> {
                val reason = msg.optString("reason")
                P2PState.errorReason = reason
                Log.d(TAG, "signal error: $reason")
                if (reason == "room-not-found") {
                    // 信令重启/host 尚未 reclaim 的瞬态：按重连重试（退避上限内自愈），
                    // 房间真没了（host 不再回来）则退避耗尽后进 error 终态
                    scheduleReconnect()
                } else {
                    // 终态错误（room-full/room-expired 等）：不重试
                    teardown()
                    onState("error")
                }
            }
        }
    }

    // ===== 自动重连（指数退避） =====

    private fun backoffMs(n: Int): Long =
        minOf(2000L * (1L shl (n - 1).coerceAtMost(4)), 30000L)

    @Synchronized
    private fun scheduleReconnect() {
        if (closed) return
        // 已有在途重连任务：直接返回。多事件源（ICE CLOSED/通道 CLOSED/心跳看门狗）会反复触发，
        // 旧实现每次都取消重排——看门狗 10s 一喊、退避 30s 的任务永远跑不了（活锁，2026-08-05 实证）
        if (reconnectFuture != null && reconnectFuture!!.isDone.not()) return
        attempts++
        if (attempts > MAX_ATTEMPTS) {
            Log.d(TAG, "reconnect gave up after $MAX_ATTEMPTS attempts")
            teardown()
            onState("error")
            return
        }
        onState("reconnecting")
        val delay = backoffMs(attempts)
        Log.d(TAG, "reconnect attempt $attempts in ${delay}ms")
        reconnectFuture = exec.schedule({
            // 健康=通道开着且 pong 新鲜（ICE 自愈的场景）；僵尸通道（开而不通）必须拆掉重建
            val healthy = channelOpen && (System.currentTimeMillis() - lastPong <= PONG_TIMEOUT_MS)
            if (!closed && !healthy) {
                closePeer()
                closeWs()
                connectWs()
            }
        }, delay, TimeUnit.MILLISECONDS)
    }

    /** 网络恢复回调：把长退避提前到现在。短退避/在途重连不打扰——
     *  真机 Clash VPN 下 onAvailable 高频触发，旧实现每次都用 0ms 新任务打断
     *  刚连上的连接（closePeer），造成重连活锁（2026-08-05 真机实证） */
    fun reconnectNow() {
        if (closed) return
        val f = reconnectFuture
        if (f != null && !f.isDone) {
            if (f.getDelay(TimeUnit.MILLISECONDS) <= 3000) return // 重连即将执行，不打扰
            f.cancel(false) // 长退避才提前
        }
        val s = P2PState.status
        if (s == "reconnecting" || s == "error" || s == "closed") {
            Log.d(TAG, "network recovered, reconnect now (was $s)")
            reconnectFuture = exec.schedule({
                if (!closed && !channelOpen) {
                    closePeer()
                    closeWs()
                    connectWs()
                }
            }, 0, TimeUnit.MILLISECONDS)
        }
    }

    private fun registerNetworkCallback() {
        try {
            val cm = appContext.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    reconnectNow()
                }
            }
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: Exception) {
            Log.d(TAG, "registerNetworkCallback failed: ${e.message}")
        }
    }

    // ===== WebRTC =====

    private fun setupPeer() {
        if (pc != null) return
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .setEnableInternalTracer(false)
                .createInitializationOptions()
        )
        // PeerConnectionFactory 必须长持有（局部变量被 GC 会 native 悬挂 SIGABRT，2026-08-05 实证）
        val f = factory ?: PeerConnectionFactory.builder().createPeerConnectionFactory().also { factory = it }
        val config = PeerConnection.RTCConfiguration(iceServers())
        var newPc: PeerConnection? = null
        newPc = f.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                ws?.send(JSONObject().put("type", "signal")
                    .put("data", JSONObject().put("ice", JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex))).toString())
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                // 旧 pc 的残余事件（重连拆旧连接触发的 CLOSED 等）不得再排重连
                if (pc !== newPc) return
                Log.d(TAG, "ice state: $state")
                when (state) {
                    PeerConnection.IceConnectionState.CONNECTED -> {
                        attempts = 0
                        onState("connected")
                    }
                    PeerConnection.IceConnectionState.FAILED,
                    PeerConnection.IceConnectionState.CLOSED -> {
                        // ICE 失败/关闭：旧版完全忽略、状态假 connected；现在走重连
                        if (!closed) scheduleReconnect()
                    }
                    else -> {}
                }
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onDataChannel(dc: DataChannel?) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddStream(stream: org.webrtc.MediaStream?) {}
            override fun onRemoveStream(stream: org.webrtc.MediaStream?) {}
            override fun onAddTrack(receiver: org.webrtc.RtpReceiver?, streams: Array<out org.webrtc.MediaStream>?) {}
            override fun onTrack(track: org.webrtc.RtpTransceiver?) {}
            override fun onRemoveTrack(receiver: org.webrtc.RtpReceiver?) {}
            override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) {}
            override fun onSignalingChange(state: PeerConnection.SignalingState?) {}
            override fun onStandardizedIceConnectionChange(state: PeerConnection.IceConnectionState?) {}
            override fun onConnectionChange(state: PeerConnection.PeerConnectionState?) {}
        }) ?: run { onState("error"); return }
        pc = newPc

        // client 发起：先建 DataChannel 再 createOffer（offer 才含 m=application 段）
        channel = pc!!.createDataChannel("touchdeck", DC_INIT)
        bindChannel(channel!!)
        pc!!.createOffer(object : org.webrtc.SdpObserver {
            override fun onCreateSuccess(desc: SessionDescription?) {
                desc ?: return
                pc?.setLocalDescription(this, desc)
                ws?.send(JSONObject().put("type", "signal")
                    .put("data", JSONObject().put("sdp", JSONObject()
                        .put("type", desc.type.canonicalForm())
                        .put("sdp", desc.description))).toString())
            }

            override fun onCreateFailure(error: String?) { scheduleReconnect() }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String?) { scheduleReconnect() }
        }, org.webrtc.MediaConstraints())
    }

    private fun handlePeerSignal(data: JSONObject) {
        val pc = pc ?: return
        val sdp = data.optJSONObject("sdp")
        if (sdp != null && sdp.optString("type") == "answer") {
            pc.setRemoteDescription(object : org.webrtc.SdpObserver {
                override fun onCreateSuccess(desc: SessionDescription?) {}
                override fun onCreateFailure(error: String?) {}
                override fun onSetSuccess() {}
                override fun onSetFailure(error: String?) { scheduleReconnect() }
            }, SessionDescription(SessionDescription.Type.ANSWER, sdp.optString("sdp")))
        }
        val ice = data.optJSONObject("ice")
        if (ice != null) {
            val c = IceCandidate(
                ice.optString("sdpMid"),
                ice.optInt("sdpMLineIndex"),
                ice.optString("candidate")
            )
            pc.addIceCandidate(c)
        }
    }

    // ===== DataChannel：按键 + 应用层心跳 =====

    private fun bindChannel(dc: DataChannel) {
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                // 旧 channel 的残余事件（重连拆旧连接触发的 CLOSED）不得再排重连
                if (channel !== dc) return
                Log.d(TAG, "channel state: ${dc.state()}")
                if (dc.state() == DataChannel.State.OPEN) {
                    channelOpen = true
                    lastPong = System.currentTimeMillis()
                    startHeartbeat()
                    onState("connected")
                    onChannelOpen()
                } else if (dc.state() == DataChannel.State.CLOSED) {
                    channelOpen = false
                    stopHeartbeat()
                    finishAllPending("disconnected", "channel-closed")
                    if (!closed) scheduleReconnect()
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                try {
                    val bytes = ByteArray(buffer.data.remaining())
                    buffer.data.get(bytes)
                    val msg = JSONObject(String(bytes, StandardCharsets.UTF_8))
                    if (msg.has("pong")) lastPong = System.currentTimeMillis()
                    // host 按钮集下发（type=="buttons"，与心跳 pong / 上行按键 {id} 区分）：
                    // 通道建立与场景切换时推送，存 P2PState 供 BubbleService 构建菜单
                    if (msg.optString("type") == "buttons") {
                        P2PState.dynamicButtons = parsePanelButtons(msg.optJSONArray("buttons"))
                        Log.d(TAG, "buttons received: ${P2PState.dynamicButtons?.size ?: 0}")
                    }
                    if (msg.optString("type") == "action-result") {
                        val requestId = msg.optString("requestId")
                        val status = msg.optString("status")
                        if (requestId.isNotEmpty() && status in setOf("queued", "executed", "blocked", "failed")) {
                            Log.d(TAG, "action result requestId=$requestId status=$status")
                            // 超时后的迟到 ACK 不得把「超时」翻成「已执行」；用户只能看到同一请求的单一终态。
                            val pending = pendingActions[requestId]
                            if (pending != null && (status == "queued" || pendingActions.remove(requestId) != null)) {
                                P2PState.actionListener?.invoke(RemoteActionResult(requestId, status, msg.optString("reason")))
                            }
                        }
                    }
                } catch (_: Exception) {}
            }
        })
    }

    private fun startHeartbeat() {
        stopHeartbeat()
        // 每 5s ping；host 回 pong。20s 无 pong 判半开（WiFi 切网僵死等）→ 重连
        pingFuture = exec.scheduleWithFixedDelay({
            try {
                val ch = channel
                if (!closed && ch != null && ch.state() == DataChannel.State.OPEN) {
                    val json = JSONObject().put("ping", System.currentTimeMillis()).toString()
                    ch.send(DataChannel.Buffer(ByteBuffer.wrap(json.toByteArray(StandardCharsets.UTF_8)), false))
                }
            } catch (_: Exception) {}
        }, PING_INTERVAL_S, PING_INTERVAL_S, TimeUnit.SECONDS)
        watchdogFuture = exec.scheduleWithFixedDelay({
            if (!closed && channelOpen && System.currentTimeMillis() - lastPong > PONG_TIMEOUT_MS) {
                Log.d(TAG, "heartbeat timeout, reconnecting")
                scheduleReconnect()
            }
        }, PONG_TIMEOUT_MS / 2, PONG_TIMEOUT_MS / 2, TimeUnit.MILLISECONDS)
    }

    private fun stopHeartbeat() {
        pingFuture?.cancel(false); pingFuture = null
        watchdogFuture?.cancel(false); watchdogFuture = null
    }

    private fun iceServers(): List<PeerConnection.IceServer> {
        val list = mutableListOf(
            PeerConnection.IceServer.builder("stun:212.135.41.88:3478").createIceServer()
        )
        val t = turn
        if (t != null) {
            val arr = t.optJSONArray("urls")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    list.add(
                        PeerConnection.IceServer.builder(arr.getString(i))
                            .setUsername(t.optString("username"))
                            .setPassword(t.optString("credential"))
                            .createIceServer()
                    )
                }
            } else {
                val single = t.optString("url", "")
                if (single.isNotEmpty()) {
                    list.add(
                        PeerConnection.IceServer.builder(single)
                            .setUsername(t.optString("username"))
                            .setPassword(t.optString("credential"))
                            .createIceServer()
                    )
                }
            }
        }
        return list
    }

    /** 解析 host 下发的 buttons 数组：元素字段 id/icon/label/sub/group/confirm/aux，全部可空兜底 */
    private fun parsePanelButtons(arr: JSONArray?): List<PanelButton>? {
        arr ?: return null
        val list = ArrayList<PanelButton>(arr.length())
        for (i in 0 until arr.length()) {
            val b = arr.optJSONObject(i) ?: continue
            list.add(
                PanelButton(
                    id = b.optString("id"),
                    icon = b.optString("icon"),
                    label = b.optString("label"),
                    sub = b.optString("sub"),
                    group = b.optString("group"),
                    confirm = b.optBoolean("confirm"),
                    aux = b.optBoolean("aux")
                )
            )
        }
        return list
    }

    /** 发送版本化动作；超时先用同一 requestId 重试一次，Host 幂等保证绝不重复执行。 */
    fun send(id: String): SendOutcome {
        return sendWithRequestId(id, UUID.randomUUID().toString())
    }

    /**
     * 同一 requestId 的二次调用仅重发同一包，不创建第二个 pending 或第二个超时器。
     * 该路径同时服务 Android 超时重试和 Debug APK 的幂等验收。
     */
    fun sendWithRequestId(id: String, requestId: String): SendOutcome {
        val existing = pendingActions[requestId]
        if (existing != null) {
            return if (sendPending(requestId, existing)) SendOutcome.QUEUED else SendOutcome.DISCONNECTED
        }
        val pending = PendingAction(id)
        // 先登记再发包：极快 ACK 也能找到 pending，不能被误当成迟到消息丢弃。
        pendingActions[requestId] = pending
        if (!sendPending(requestId, pending)) {
            pendingActions.remove(requestId, pending)
            return SendOutcome.DISCONNECTED
        }
        exec.schedule({ checkActionTimeout(requestId) }, 4000, TimeUnit.MILLISECONDS)
        Log.d(TAG, "action queued requestId=$requestId buttonId=$id")
        return SendOutcome.QUEUED
    }

    private fun sendPending(requestId: String, pending: PendingAction): Boolean {
        val ch = channel ?: return false
        if (ch.state() != DataChannel.State.OPEN) return false
        val json = JSONObject().put("v", 1).put("type", "action")
            .put("requestId", requestId).put("buttonId", pending.buttonId).toString()
        return try { ch.send(DataChannel.Buffer(ByteBuffer.wrap(json.toByteArray(StandardCharsets.UTF_8)), false)) } catch (_: Exception) { false }
    }

    private fun checkActionTimeout(requestId: String) {
        val pending = pendingActions[requestId] ?: return
        if (pending.attempts == 0 && sendPending(requestId, pending)) {
            pending.attempts++
            exec.schedule({ checkActionTimeout(requestId) }, 4000, TimeUnit.MILLISECONDS)
            return
        }
        if (pendingActions.remove(requestId) != null) {
            Log.d(TAG, "action terminal requestId=$requestId status=timeout reason=ack-timeout")
            P2PState.actionListener?.invoke(RemoteActionResult(requestId, "timeout", "ack-timeout"))
        }
    }

    private fun finishAllPending(status: String, reason: String) {
        val ids = pendingActions.keys.toList()
        for (requestId in ids) {
            if (pendingActions.remove(requestId) != null) {
                Log.d(TAG, "action terminal requestId=$requestId status=$status reason=$reason")
                P2PState.actionListener?.invoke(RemoteActionResult(requestId, status, reason))
            }
        }
    }

    // ===== 清理 =====

    private fun closePeer() {
        stopHeartbeat()
        channelOpen = false
        finishAllPending("disconnected", "peer-closed")
        try { channel?.close() } catch (_: Exception) {}
        try { channel?.dispose() } catch (_: Exception) {}
        try { pc?.close() } catch (_: Exception) {}
        channel = null
        pc = null
    }

    private fun closeWs() {
        if (ws != null) intentionalWsClose = true
        try { ws?.close() } catch (_: Exception) {}
        ws = null
    }

    fun teardown() {
        closed = true
        reconnectFuture?.cancel(false); reconnectFuture = null
        closePeer()
        closeWs()
        try { factory?.dispose() } catch (_: Exception) {}
        factory = null
        networkCallback?.let {
            try {
                val cm = appContext.getSystemService(android.content.Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                cm.unregisterNetworkCallback(it)
            } catch (_: Exception) {}
        }
        networkCallback = null
    }
}
