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
 * Home screen: edit the TouchDeck server URL, grant overlay permission,
 * start/stop the floating bubble service.
 */
class MainActivity : Activity() {

    companion object {
        const val PREFS_NAME = "touchdeck"
        const val KEY_SERVER_URL = "server_url"
        const val DEFAULT_SERVER_URL = "http://192.168.31.199:7758"
    }

    private lateinit var prefs: SharedPreferences
    private lateinit var urlEdit: EditText
    private lateinit var statusText: TextView
    private lateinit var grantButton: Button
    private lateinit var toggleButton: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences(PREFS_NAME, MODE_PRIVATE)

        val pad = (resources.displayMetrics.density * 20).toInt()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad, pad, pad)
            gravity = Gravity.CENTER_HORIZONTAL
        }

        val label = TextView(this).apply {
            text = getString(R.string.label_server)
            textSize = 14f
        }
        urlEdit = EditText(this).apply {
            setText(prefs.getString(KEY_SERVER_URL, DEFAULT_SERVER_URL))
            setSingleLine()
        }
        statusText = TextView(this).apply {
            textSize = 14f
            setPadding(0, pad / 2, 0, pad / 2)
        }
        grantButton = Button(this).apply {
            text = getString(R.string.btn_grant)
            setOnClickListener { requestOverlayPermission() }
        }
        toggleButton = Button(this).apply {
            setOnClickListener { onToggleClicked() }
        }

        root.addView(label, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(urlEdit, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(statusText, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(grantButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        root.addView(toggleButton, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))

        setContentView(root)
    }

    override fun onResume() {
        super.onResume()
        refreshState()
    }

    override fun onPause() {
        super.onPause()
        saveUrl()
    }

    private fun onToggleClicked() {
        if (!Settings.canDrawOverlays(this)) {
            requestOverlayPermission()
            return
        }
        saveUrl()
        if (BubbleServiceState.running) {
            stopService(Intent(this, BubbleService::class.java))
            BubbleServiceState.running = false
        } else {
            startForegroundService(Intent(this, BubbleService::class.java))
            BubbleServiceState.running = true
        }
        refreshState()
    }

    private fun saveUrl() {
        val url = urlEdit.text.toString().trim()
        if (url.isNotEmpty()) {
            prefs.edit().putString(KEY_SERVER_URL, url).apply()
        }
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
        grantButton.isEnabled = !canOverlay
        grantButton.alpha = if (canOverlay) 0.4f else 1f

        when {
            !canOverlay -> {
                statusText.text = getString(R.string.status_no_permission)
                statusText.setTextColor(0xFFD32F2F.toInt())
                toggleButton.text = getString(R.string.btn_start)
                toggleButton.isEnabled = true
            }
            BubbleServiceState.running -> {
                statusText.text = getString(R.string.status_running)
                statusText.setTextColor(Color.DKGRAY)
                toggleButton.text = getString(R.string.btn_stop)
            }
            else -> {
                statusText.text = getString(R.string.status_stopped)
                statusText.setTextColor(Color.DKGRAY)
                toggleButton.text = getString(R.string.btn_start)
            }
        }
    }
}

/** In-memory flag so the home screen can show start/stop state. */
object BubbleServiceState {
    @Volatile
    var running: Boolean = false
}
