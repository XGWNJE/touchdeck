package cn.touchdeck.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.atomic.AtomicBoolean

/** Debug APK only: drives the production pairing path without relying on a device IME. */
class DebugPairReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return

        val pendingResult = goAsync()
        val finished = AtomicBoolean(false)
        val finish = Runnable {
            if (finished.compareAndSet(false, true)) pendingResult.finish()
        }
        Handler(Looper.getMainLooper()).postDelayed(finish, 15_000)

        val code = intent.getStringExtra("roomCode").orEmpty().trim()
        val pairKey = intent.getStringExtra("pairKey").orEmpty().trim()
        if (!code.matches(Regex("^\\d{6}$"))) {
            Log.d(TAG, "pairing rejected: invalid room code")
            finish.run()
            return
        }

        val prefs = context.getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE)
        // 与 MainActivity 保持一致：显式提供新 pairKey 时必须覆盖同房号的旧 deviceKey，
        // 否则服务端撤销登记后 Debug 验收永远只会重放已失效凭据。
        val deviceKey = if (pairKey.length >= 24) null else if (prefs.getString(MainActivity.KEY_DEVICE_ROOM, null) == code) {
            prefs.getString(MainActivity.KEY_DEVICE_KEY, null)
        } else null
        if (deviceKey.isNullOrBlank() && pairKey.length < 24) {
            Log.d(TAG, "pairing rejected: credential required")
            finish.run()
            return
        }

        prefs.edit().putString(MainActivity.KEY_ROOM_CODE, code).apply()
        val signalUrl = prefs.getString(MainActivity.KEY_SIGNAL_URL, MainActivity.DEFAULT_SIGNAL_URL).orEmpty()
        runCatching {
            context.startForegroundService(Intent(context, BubbleService::class.java))
        }.onFailure { Log.d(TAG, "debug foreground service start failed: ${it.javaClass.simpleName}") }
        P2PState.start(
            signalUrl,
            code,
            pairKey,
            deviceKey,
            { key ->
                prefs.edit()
                    .putString(MainActivity.KEY_DEVICE_KEY, key)
                    .putString(MainActivity.KEY_DEVICE_ROOM, code)
                    .apply()
            },
            { Log.d(TAG, "host fingerprint received") },
            {
                Log.d(TAG, "data channel open")
                finish.run()
            },
        )
        Log.d(TAG, "pairing started")
    }

    companion object {
        private const val ACTION = "cn.touchdeck.app.DEBUG_PAIR"
        private const val TAG = "TouchDeckDebugPair"
    }
}
