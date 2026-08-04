package cn.touchdeck.app

import android.util.Log
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStatsReport
import org.webrtc.SessionDescription
import org.webrtc.DataChannel.Init as DcInit
import org.java_websocket.client.WebSocketClient
import org.java_websocket.handshake.ServerHandshake
import org.json.JSONObject
import java.net.URI
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets

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
    var status: String = "idle"          // idle/connecting/ready/connected/error/closed
    @Volatile
    var roomCode: String = ""
    var listener: ((String) -> Unit)? = null

    fun start(signalUrl: String, code: String, onOpen: () -> Unit) {
        stop()
        roomCode = code
        val c = P2PClient(
            signalUrl, code,
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
        listener?.invoke("idle")
    }

    fun send(id: String): Boolean = client?.send(id) ?: false
}
class P2PClient(
    private val signalUrl: String,
    private val roomCode: String,
    private val onState: (String) -> Unit,      // connecting / ready / connected / error / closed
    private val onChannelOpen: () -> Unit,
    ctx: android.content.Context?
) {
    companion object {
        private const val TAG = "TouchDeckP2P"
        private val DC_INIT = DcInit().apply { ordered = true; maxRetransmits = -1 }
    }

    private val appContext: android.content.Context = ctx
        ?: throw IllegalStateException("P2PState.appContext must be set before P2P start")

    private var ws: WebSocketClient? = null
    private var pc: PeerConnection? = null
    private var factory: PeerConnectionFactory? = null
    private var channel: DataChannel? = null
    private var turn: JSONObject? = null
    private var closed = false

    fun start() {
        closed = false
        onState("connecting")
        try {
            ws = object : WebSocketClient(URI("$signalUrl".trimEnd('/'))) {
                override fun onOpen(handshake: ServerHandshake?) {
                    send(JSONObject().put("type", "join-room").put("code", roomCode).toString())
                }

                override fun onMessage(message: String?) {
                    try {
                        handleSignal(JSONObject(message ?: "{}"))
                    } catch (e: Exception) {
                        Log.d(TAG, "signal parse error: ${e.message}")
                    }
                }

                override fun onClose(code: Int, reason: String?, remote: Boolean) {
                    if (!closed) onState("closed")
                }

                override fun onError(ex: Exception?) {
                    if (!closed) onState("error")
                }
            }
            ws?.connect()
        } catch (e: Exception) {
            onState("error")
        }
    }

    private fun handleSignal(msg: JSONObject) {
        when (msg.optString("type")) {
            "room" -> {
                turn = msg.optJSONObject("turn")
                onState("ready")
                setupPeer()
            }
            "signal" -> {
                if (pc == null) setupPeer()
                handlePeerSignal(msg.optJSONObject("data") ?: JSONObject())
            }
            "peer-left" -> {
                teardown()
                onState("closed")
            }
            "error" -> {
                Log.d(TAG, "signal error: " + msg.optString("reason"))
                onState("error")
            }
        }
    }

    private fun setupPeer() {
        if (pc != null) return
        Log.d(TAG, "setupPeer: appContext=" + appContext.javaClass.simpleName + " init=" +
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(appContext)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions()
            ))
        val f = PeerConnectionFactory.builder().createPeerConnectionFactory()
        factory = f
        Log.d(TAG, "setupPeer: factory created")
        val config = org.webrtc.PeerConnection.RTCConfiguration(iceServers())
        pc = f.createPeerConnection(config, object : PeerConnection.Observer {
            override fun onIceCandidate(candidate: IceCandidate?) {
                candidate ?: return
                ws?.send(JSONObject().put("type", "signal")
                    .put("data", JSONObject().put("ice", JSONObject()
                        .put("candidate", candidate.sdp)
                        .put("sdpMid", candidate.sdpMid)
                        .put("sdpMLineIndex", candidate.sdpMLineIndex))).toString())
            }

            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
                if (state == PeerConnection.IceConnectionState.CONNECTED) onState("connected")
            }
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onDataChannel(dc: DataChannel?) {
                dc ?: return
                channel = dc
                bindChannel(dc)
            }
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

            override fun onCreateFailure(error: String?) { onState("error") }
            override fun onSetSuccess() {}
            override fun onSetFailure(error: String?) { onState("error") }
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
                override fun onSetFailure(error: String?) { onState("error") }
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

    private fun bindChannel(dc: DataChannel) {
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                if (dc.state() == DataChannel.State.OPEN) onChannelOpen()
            }
            override fun onMessage(buffer: DataChannel.Buffer) {}
        })
    }

    private fun iceServers(): List<org.webrtc.PeerConnection.IceServer> {
        val list = mutableListOf(
            org.webrtc.PeerConnection.IceServer.builder("stun:212.135.41.88:3478").createIceServer()
        )
        val t = turn
        if (t != null) {
            val arr = t.optJSONArray("urls")
            if (arr != null) {
                for (i in 0 until arr.length()) {
                    list.add(
                        org.webrtc.PeerConnection.IceServer.builder(arr.getString(i))
                            .setUsername(t.optString("username"))
                            .setPassword(t.optString("credential"))
                            .createIceServer()
                    )
                }
            } else {
                val single = t.optString("url", "")
                if (single.isNotEmpty()) {
                    list.add(
                        org.webrtc.PeerConnection.IceServer.builder(single)
                            .setUsername(t.optString("username"))
                            .setPassword(t.optString("credential"))
                            .createIceServer()
                    )
                }
            }
        }
        return list
    }

    /** 发送按键；通道未开返回 false（调用方回退 HTTP） */
    fun send(id: String): Boolean {
        val ch = channel ?: run { Log.d(TAG, "send($id): channel null"); return false }
        if (ch.state() != DataChannel.State.OPEN) { Log.d(TAG, "send($id): state=" + ch.state()); return false }
        val json = JSONObject().put("id", id).toString()
        ch.send(DataChannel.Buffer(ByteBuffer.wrap(json.toByteArray(StandardCharsets.UTF_8)), false))
        Log.d(TAG, "send($id): ok")
        return true
    }

    fun teardown() {
        closed = true
        try { channel?.close() } catch (_: Exception) {}
        try { pc?.close() } catch (_: Exception) {}
        try { ws?.close() } catch (_: Exception) {}
        try { factory?.dispose() } catch (_: Exception) {}
        channel = null
        pc = null
        factory = null
        ws = null
    }
}
