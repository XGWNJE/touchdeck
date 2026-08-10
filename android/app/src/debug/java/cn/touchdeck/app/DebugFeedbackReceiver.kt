package cn.touchdeck.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.UUID

/** Debug APK only: previews real BubbleService feedback without injecting a Windows action. */
class DebugFeedbackReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val status = intent.getStringExtra("status").orEmpty()
        if (status !in ALLOWED_STATUSES) {
            Log.d(TAG, "feedback rejected: invalid status")
            return
        }
        Handler(Looper.getMainLooper()).post {
            P2PState.actionListener?.invoke(
                RemoteActionResult(UUID.randomUUID().toString(), status, "debug-preview")
            )
            Log.d(TAG, "feedback previewed status=$status")
        }
    }

    companion object {
        private const val ACTION = "cn.touchdeck.app.DEBUG_FEEDBACK"
        private const val TAG = "TouchDeckDebugFeedback"
        private val ALLOWED_STATUSES = setOf(
            "queued", "executed", "blocked", "failed", "disconnected", "timeout"
        )
    }
}
