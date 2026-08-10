package cn.touchdeck.app

import android.app.Activity
import android.content.Intent
import android.content.SharedPreferences
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.Settings
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/**
 * 主界面：启动/停止悬浮球、悬浮窗授权、P2P 房间码连接（高级设置折叠区）。
 * 远程按键只走 P2P 直连，无服务器转发。
 */
class MainActivity : Activity() {

    companion object {
        const val PREFS_NAME = "touchdeck"
        const val KEY_SIGNAL_URL = "signal_url"
        const val KEY_ROOM_CODE = "room_code"
        const val KEY_DEVICE_KEY = "device_key"
        const val KEY_DEVICE_ROOM = "device_room"
        const val DEFAULT_SIGNAL_URL = "wss://api.xgwnje.cn/signal"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var statusText: TextView
    private lateinit var toggleButton: Button
    private lateinit var grantButton: Button
    private lateinit var advBody: LinearLayout
    private lateinit var p2pStateText: TextView
    private var advOpen = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)
        P2PState.appContext = applicationContext

        val pad = (resources.displayMetrics.density * 20).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val title = TextView(this).apply {
            text = getString(R.string.app_name)
            textSize = 22f
            setPadding(0, 0, 0, pad / 2)
        }
        statusText = TextView(this).apply {
            textSize = 15f
            setPadding(0, 0, 0, pad)
            gravity = Gravity.CENTER
        }
        grantButton = Button(this).apply {
            text = getString(R.string.btn_grant)
            setOnClickListener { requestOverlayPermission() }
        }
        toggleButton = Button(this).apply {
            textSize = 16f
            setOnClickListener { onToggleClicked() }
        }

        // 高级设置（默认折叠）：P2P 连接区
        val advToggle = TextView(this).apply {
            text = getString(R.string.label_advanced)
            textSize = 13f
            setPadding(0, pad, 0, pad / 2)
            setTextColor(0xFF9AC8FF.toInt())
        }
        advBody = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            visibility = android.view.View.GONE
        }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)

        val p2pLabel = TextView(this).apply {
            text = getString(R.string.label_p2p)
            textSize = 13f
        }
        val p2pRow = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        val roomEdit = EditText(this).apply {
            hint = getString(R.string.hint_room_code)
            setSingleLine()
            // 房号持久化：上次连接的房号预填，断线重连/重开 App 不必重输
            setText(prefs.getString(KEY_ROOM_CODE, ""))
            layoutParams = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        }
        val pairEdit = EditText(this).apply {
            hint = "首次连接输入 Windows 显示的配对密钥"
            setSingleLine()
        }
        val p2pBtn = Button(this).apply {
            text = getString(R.string.btn_p2p_connect)
            setOnClickListener { toggleP2P(roomEdit, pairEdit) }
        }
        p2pRow.addView(roomEdit)
        p2pRow.addView(p2pBtn)
        val p2pState = TextView(this).apply {
            text = getString(R.string.status_p2p_idle)
            textSize = 12f
            setTextColor(0xFF888888.toInt())
        }
        p2pStateText = p2pState
        advBody.addView(p2pLabel, lp)
        advBody.addView(p2pRow, lp)
        advBody.addView(pairEdit, lp)
        advBody.addView(p2pState, lp)
        val advHint = TextView(this).apply {
            text = getString(R.string.hint_advanced)
            textSize = 12f
            setTextColor(0xFF888888.toInt())
        }
        advBody.addView(advHint, lp)
        root.addView(title)
        root.addView(statusText)
        root.addView(grantButton, lp)
        root.addView(toggleButton, lp)
        root.addView(advToggle)
        root.addView(advBody)
        setContentView(root)

        advToggle.setOnClickListener {
            advOpen = !advOpen
            advBody.visibility = if (advOpen) android.view.View.VISIBLE else android.view.View.GONE
            advToggle.text = if (advOpen) "▲ " + getString(R.string.label_advanced)
                else "▼ " + getString(R.string.label_advanced)
        }

        // P2P 状态监听（信令回调线程 → 主线程更新 UI）
        P2PState.listener = { s ->
            runOnUiThread {
                renderP2PState(s)
                refreshP2PButton()
            }
        }
        // Activity 可能在 Debug receiver/后台自动续连之后才打开；监听器不会重放旧事件，
        // 因此首次渲染必须读取当前状态，不能把已连接设备显示成“未连接”。
        renderP2PState(P2PState.status)
        refreshP2PButton()
    }

    private fun renderP2PState(state: String) {
        p2pStateText.text = when (state) {
            "connecting" -> getString(R.string.status_p2p_connecting)
            "ready" -> if (P2PState.hostFingerprint.isBlank()) getString(R.string.status_p2p_ready)
                else "已核验主机 ${P2PState.hostFingerprint}，正在建立直连"
            "connected" -> if (P2PState.hostFingerprint.isBlank()) getString(R.string.status_p2p_connected)
                else "已核验主机 ${P2PState.hostFingerprint}，直连已建立"
            "reconnecting" -> getString(R.string.status_p2p_reconnecting)
            "host-gone" -> getString(R.string.status_p2p_hostgone)
            "error" -> when (P2PState.errorReason) {
                "pairing-required", "device-revoked" -> "设备凭据已失效，请输入 Windows 显示的新配对密钥"
                "state-unavailable" -> "信令身份状态暂不可用，请稍后重试"
                else -> getString(R.string.status_p2p_error)
            }
            "closed" -> getString(R.string.status_p2p_closed)
            else -> getString(R.string.status_p2p_idle)
        }
    }

    /** P2P 连接/断开切换（房间码来自输入框） */
    private fun toggleP2P(roomEdit: EditText, pairEdit: EditText) {
        if (P2PState.status != "idle" && P2PState.status != "error" && P2PState.status != "closed") {
            P2PState.stop()
        } else {
            val code = roomEdit.text.toString().trim()
            if (code.length != 6 || !code.all { it.isDigit() }) {
                p2pStateText.text = getString(R.string.status_p2p_badcode)
                return
            }
            prefs.edit().putString(KEY_ROOM_CODE, code).apply()
            val pairKey = pairEdit.text.toString().trim()
            // 用户明确输入新配对密钥时优先重新登记；否则旧 deviceKey 会永远遮住 pairKey，
            // 被 Host 撤销后的设备只能清应用数据才能恢复。
            val deviceKey = if (pairKey.length >= 24) null
                else if (prefs.getString(KEY_DEVICE_ROOM, null) == code) prefs.getString(KEY_DEVICE_KEY, null)
                else null
            if (deviceKey.isNullOrBlank() && pairKey.length < 24) {
                p2pStateText.text = "请输入首次配对密钥"
                return
            }
            val signal = prefs.getString(KEY_SIGNAL_URL, DEFAULT_SIGNAL_URL).orEmpty()
            P2PState.start(signal, code, pairKey, deviceKey,
                { key -> prefs.edit().putString(KEY_DEVICE_KEY, key).putString(KEY_DEVICE_ROOM, code).apply() },
                { fingerprint -> runOnUiThread { p2pStateText.text = "已核验主机 $fingerprint，正在建立直连" } }
            ) {
                // 通道打开（无 UI 动作，按键走 P2PState.send）
            }
        }
        refreshP2PButton()
    }

    private fun refreshP2PButton() {
        // 连接中/已连/重连中/等主机恢复 都视为活跃态，按钮显示「断开」
        val active = P2PState.status !in listOf("idle", "error", "closed")
        val btn = (advBody.getChildAt(1) as? LinearLayout)?.getChildAt(1) as? Button
        btn?.text = if (active) getString(R.string.btn_p2p_disconnect) else getString(R.string.btn_p2p_connect)
        btn?.isEnabled = true
    }

    override fun onResume() {
        super.onResume()
        refreshState()
    }

    private fun onToggleClicked() {
        if (!Settings.canDrawOverlays(this)) {
            requestOverlayPermission()
            return
        }
        if (BubbleServiceState.running) {
            stopService(Intent(this, BubbleService::class.java))
            BubbleServiceState.running = false
        } else {
            startForegroundService(Intent(this, BubbleService::class.java))
            BubbleServiceState.running = true
        }
        refreshState()
    }

    private fun requestOverlayPermission() {
        startActivity(
            Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:$packageName")
            )
        )
    }

    private fun refreshState() {
        val canOverlay = Settings.canDrawOverlays(this)
        grantButton.visibility = if (canOverlay) android.view.View.GONE else android.view.View.VISIBLE
        when {
            !canOverlay -> {
                statusText.text = getString(R.string.status_no_permission)
                statusText.setTextColor(0xFFD32F2F.toInt())
                toggleButton.text = getString(R.string.btn_start)
                toggleButton.isEnabled = false
            }
            BubbleServiceState.running -> {
                statusText.text = getString(R.string.status_running)
                statusText.setTextColor(0xFF2E7D32.toInt())
                toggleButton.text = getString(R.string.btn_stop)
                toggleButton.isEnabled = true
            }
            else -> {
                statusText.text = getString(R.string.status_stopped)
                statusText.setTextColor(Color.DKGRAY)
                toggleButton.text = getString(R.string.btn_start)
                toggleButton.isEnabled = true
            }
        }
    }
}

/** In-memory flag so the home screen can show start/stop state. */
object BubbleServiceState {
    @Volatile
    var running: Boolean = false
}
