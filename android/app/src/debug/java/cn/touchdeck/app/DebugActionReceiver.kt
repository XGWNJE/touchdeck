package cn.touchdeck.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Debug APK 专用：ADB 可用固定 requestId 重发同一动作，Release 不包含本类。 */
class DebugActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val buttonId = intent.getStringExtra("buttonId") ?: return
        val requestId = intent.getStringExtra("requestId") ?: return
        val repeat = intent.getIntExtra("repeat", 1).coerceIn(1, 8)
        repeat(repeat) {
            val outcome = P2PState.sendWithRequestIdForTest(buttonId, requestId)
            Log.d("TouchDeckDebug", "send requestId=$requestId buttonId=$buttonId repeat=${it + 1} outcome=$outcome")
        }
    }
}
