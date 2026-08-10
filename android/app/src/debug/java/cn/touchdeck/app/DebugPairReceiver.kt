package cn.touchdeck.app

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log

/** Debug APK only: drives the production pairing path without relying on a device IME. */
class DebugPairReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return

        val code = intent.getStringExtra("roomCode").orEmpty().trim()
        val pairKey = intent.getStringExtra("pairKey").orEmpty().trim()
        if (!code.matches(Regex("^\\d{6}$"))) {
            Log.d(TAG, "pairing rejected: invalid room code")
            return
        }

        val prefs = context.getSharedPreferences(MainActivity.PREFS_NAME, Context.MODE_PRIVATE)
        val deviceKey = if (prefs.getString(MainActivity.KEY_DEVICE_ROOM, null) == code) {
            prefs.getString(MainActivity.KEY_DEVICE_KEY, null)
        } else null
        if (deviceKey.isNullOrBlank() && pairKey.length < 24) {
            Log.d(TAG, "pairing rejected: credential required")
            return
        }

        prefs.edit().putString(MainActivity.KEY_ROOM_CODE, code).apply()
        val signalUrl = prefs.getString(MainActivity.KEY_SIGNAL_URL, MainActivity.DEFAULT_SIGNAL_URL).orEmpty()
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
            { Log.d(TAG, "data channel open") },
        )
        Log.d(TAG, "pairing started")
    }

    companion object {
        private const val ACTION = "cn.touchdeck.app.DEBUG_PAIR"
        private const val TAG = "TouchDeckDebugPair"
    }
}
