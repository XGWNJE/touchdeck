package cn.touchdeck.app

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.SharedPreferences
import android.content.res.Configuration
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.IBinder
import android.animation.ValueAnimator
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.animation.OvershootInterpolator
import android.widget.FrameLayout
import org.json.JSONObject
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * Floating bubble service: a draggable overlay ball that expands into a
 * WebView panel loading the TouchDeck server page.
 */
class BubbleService : Service() {

    companion object {
        private const val CHANNEL_ID = "bubble"
        private const val NOTIFICATION_ID = 1
        private const val PREF_X = "bubble_x"
        private const val PREF_Y = "bubble_y"
    }

    private lateinit var windowManager: WindowManager
    private lateinit var prefs: SharedPreferences

    private var bubbleView: View? = null
    private var bubbleParams: WindowManager.LayoutParams? = null
    private var panelView: FrameLayout? = null
    private var panelExpanded = false
    // 滑选手势桥：菜单视图与展开层屏幕原点偏移（raw 坐标 → 视图坐标）
    private var menuView: RadialMenuView? = null
    private var overlayOffsetX = 0
    private var overlayOffsetY = 0

    private var screenW = 0
    private var screenH = 0
    private var bubbleSize = 0

    // 通讯：P2P 直连（DataChannel 按键），配置/图标全部来自离线 assets
    private var panelConfig: JSONObject? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        BubbleServiceState.running = true
        windowManager = getSystemService(WINDOW_SERVICE) as WindowManager
        prefs = getSharedPreferences(MainActivity.PREFS_NAME, MODE_PRIVATE)
        refreshScreenMetrics()
        bubbleSize = dp(52)
        startForegroundWithNotification()
        showBubble()
    }

    /** 屏幕尺寸现用现取：旋转后旧值会让球被夹死在旧范围、菜单中心与可用半径全算错（v0.3.0 实证） */
    private fun refreshScreenMetrics() {
        screenW = resources.displayMetrics.widthPixels
        screenH = resources.displayMetrics.heightPixels
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        refreshScreenMetrics()
        bubbleParams?.let { p ->
            p.x = p.x.coerceIn(0, screenW - bubbleSize)
            p.y = p.y.coerceIn(0, screenH - bubbleSize)
            bubbleView?.let { v -> runCatching { windowManager.updateViewLayout(v, p) } }
        }
    }

    override fun onDestroy() {
        BubbleServiceState.running = false
        removePanel()
        bubbleView?.let { runCatching { windowManager.removeView(it) } }
        bubbleView = null
        super.onDestroy()
    }

    // ---- foreground notification ----

    private fun startForegroundWithNotification() {
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, getString(R.string.channel_name), NotificationManager.IMPORTANCE_MIN)
        )
        val openIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.app_name))
            .setContentText(getString(R.string.notification_text))
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setContentIntent(openIntent)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(
                NOTIFICATION_ID, notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            )
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    // ---- bubble ----

    @SuppressLint("ClickableViewAccessibility")
    private fun showBubble() {
        val bubble = View(this)
        val stroke = dp(1)
        bubble.background = GradientDrawable().apply {
            shape = GradientDrawable.OVAL
            setColor(Color.WHITE)
            setStroke(stroke, 0x33000000)
        }
        bubble.alpha = 0.6f
        bubble.elevation = dp(4).toFloat()

        val params = WindowManager.LayoutParams(
            bubbleSize, bubbleSize,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN, // 与展开层同一坐标系，菜单才能对齐球心
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.TOP or Gravity.START
            x = prefs.getInt(PREF_X, screenW - bubbleSize).coerceIn(0, screenW - bubbleSize)
            y = prefs.getInt(PREF_Y, screenH / 2).coerceIn(0, screenH - bubbleSize)
        }

        bubble.setOnTouchListener(BubbleTouchListener(params))
        windowManager.addView(bubble, params)
        bubbleView = bubble
        bubbleParams = params
    }

    private inner class BubbleTouchListener(
        private val params: WindowManager.LayoutParams
    ) : View.OnTouchListener {
        private var downRawX = 0f
        private var downRawY = 0f
        private var startX = 0
        private var startY = 0
        private var dragging = false
        private var slideMode = false
        private var holdDragMode = false
        private val clickSlop = dp(10)
        private val holdHandler = android.os.Handler(android.os.Looper.getMainLooper())
        private var holdRunnable: Runnable? = null

        override fun onTouch(v: View, event: MotionEvent): Boolean {
            when (event.actionMasked) {
                MotionEvent.ACTION_DOWN -> {
                    downRawX = event.rawX
                    downRawY = event.rawY
                    startX = params.x
                    startY = params.y
                    dragging = false
                    slideMode = false
                    holdDragMode = false
                    v.animate().alpha(0.85f).setDuration(100).start()
                    // 按住不动超 350ms = 进入拖球模式（此时再移动是挪位置，不是滑选）
                    val r = Runnable {
                        holdDragMode = true
                        if (panelExpanded) collapsePanel() // 拖球前收起菜单，防止滞留盖扇区
                    }
                    holdRunnable = r
                    holdHandler.postDelayed(r, 350)
                    return true
                }
                MotionEvent.ACTION_MOVE -> {
                    val dx = event.rawX - downRawX
                    val dy = event.rawY - downRawY
                    if (holdDragMode) {
                        // 拖球模式：挪位置
                        dragging = true
                        params.x = (startX + dx).roundToInt().coerceIn(0, screenW - bubbleSize)
                        params.y = (startY + dy).roundToInt().coerceIn(0, screenH - bubbleSize)
                        runCatching { windowManager.updateViewLayout(v, params) }
                        return true
                    }
                    if (!slideMode && (abs(dx) >= clickSlop || abs(dy) >= clickSlop)) {
                        // 按下即动 = 滑选模式：菜单以起点球位为锚展开，球跟随手指
                        slideMode = true
                        holdRunnable?.let { holdHandler.removeCallbacks(it) }
                        if (!panelExpanded) expandPanel(skipBubbleRetop = true)
                    }
                    if (slideMode) {
                        params.x = (event.rawX - bubbleSize / 2f).roundToInt()
                            .coerceIn(0, screenW - bubbleSize)
                        params.y = (event.rawY - bubbleSize / 2f).roundToInt()
                            .coerceIn(0, screenH - bubbleSize)
                        runCatching { windowManager.updateViewLayout(v, params) }
                        // 高亮跟随手指（raw 全屏坐标 → 展开层视图坐标）
                        menuView?.updatePointer(
                            event.rawX - overlayOffsetX,
                            event.rawY - overlayOffsetY
                        )
                    }
                    return true
                }
                MotionEvent.ACTION_UP -> {
                    v.animate().alpha(0.6f).setDuration(150).start()
                    holdRunnable?.let { holdHandler.removeCallbacks(it) }
                    android.util.Log.d(
                        "TouchDeck",
                        "bubble UP raw=(${event.rawX},${event.rawY}) slide=$slideMode drag=$holdDragMode expanded=$panelExpanded"
                    )
                    when {
                        slideMode -> {
                            // 松手确认：命中扇区=选中生效，落空=取消
                            menuView?.releasePointer(
                                event.rawX - overlayOffsetX,
                                event.rawY - overlayOffsetY
                            ) ?: run { if (panelExpanded) collapsePanel() }
                            // 球回到手势起点：滑选不是挪位置
                            params.x = startX
                            params.y = startY
                            runCatching { windowManager.updateViewLayout(v, params) }
                        }
                        holdDragMode -> snapToEdge(params)
                        else -> {
                            v.performClick()
                            if (panelExpanded) collapsePanel() else expandPanel()
                        }
                    }
                    slideMode = false
                    dragging = false
                    return true
                }
                MotionEvent.ACTION_CANCEL -> {
                    v.animate().alpha(0.6f).setDuration(150).start()
                    android.util.Log.d("TouchDeck", "bubble CANCEL slide=$slideMode drag=$holdDragMode")
                    holdRunnable?.let { holdHandler.removeCallbacks(it) }
                    if (slideMode) {
                        params.x = startX
                        params.y = startY
                        runCatching { windowManager.updateViewLayout(v, params) }
                        if (panelExpanded) collapsePanel()
                    } else if (holdDragMode) {
                        snapToEdge(params)
                    }
                    slideMode = false
                    dragging = false
                    return true
                }
            }
            return false
        }
    }

    private fun snapToEdge(params: WindowManager.LayoutParams) {
        // 只有松手时靠近边缘才吸附；停在屏幕中间保持原位（360° 整圆展开需要）
        val snapZone = dp(56)
        val target = when {
            params.x <= snapZone -> 0
            params.x >= screenW - bubbleSize - snapZone -> screenW - bubbleSize
            else -> {
                savePosition(params.x, params.y)
                return
            }
        }
        if (target == params.x) {
            savePosition(params.x, params.y)
            return
        }
        ValueAnimator.ofInt(params.x, target).apply {
            duration = 200
            interpolator = DecelerateInterpolator()
            addUpdateListener { anim ->
                params.x = anim.animatedValue as Int
                bubbleView?.let { runCatching { windowManager.updateViewLayout(it, params) } }
            }
            start()
        }
        savePosition(target, params.y)
    }

    private fun savePosition(x: Int, y: Int) {
        prefs.edit().putInt(PREF_X, x).putInt(PREF_Y, y).apply()
    }

    // ---- panel（原生 View 网格；数据来自 assets/panel.json，由 scripts/build-panel-assets.mjs 从配置包生成） ----

    private fun loadPanelConfig(): JSONObject =
        panelConfig ?: JSONObject(assets.open("panel.json").bufferedReader().readText()).also { panelConfig = it }

    /** 颜色解析：兼容主题包里的 "#rrggbb"、"rgba(r,g,b,a)"、"rgb(r,g,b)" */
    private fun parseCssColor(s: String?, fallback: Int): Int {
        if (s.isNullOrBlank()) return fallback
        val t = s.trim()
        if (t.startsWith("#")) return runCatching { Color.parseColor(t) }.getOrDefault(fallback)
        val m = Regex("""rgba?\(([^)]+)\)""").find(t) ?: return fallback
        val parts = m.groupValues[1].split(",").map { it.trim().toFloatOrNull() ?: return fallback }
        if (parts.size < 3) return fallback
        val a = if (parts.size >= 4) (parts[3] * 255).roundToInt() else 255
        return Color.argb(a.coerceIn(0, 255), parts[0].roundToInt(), parts[1].roundToInt(), parts[2].roundToInt())
    }

    private val iconBitmaps = HashMap<String, Bitmap>()

    /** 图标优先级：离线 assets PNG → 无（文字回退） */
    private fun resolveIconBitmap(name: String): Bitmap? {
        if (name.isEmpty()) return null
        return iconBitmaps[name] ?: runCatching {
            assets.open("icons/$name.png").use { BitmapFactory.decodeStream(it) }
        }.getOrNull()?.also { iconBitmaps[name] = it }
    }

    private fun expandPanel(skipBubbleRetop: Boolean = false) {
        if (panelExpanded) return
        panelExpanded = true
        refreshScreenMetrics()
        val cfg = loadPanelConfig()
        val theme = cfg.getJSONObject("theme")
        val btn = theme.getJSONObject("button")
        val groups = theme.optJSONObject("groups")
        val buttons = cfg.getJSONArray("buttons")

        // 菜单项：同一套 panel.json 数据（分组配色 + 主题图标）
        val items = ArrayList<RadialMenuView.Item>()
        for (i in 0 until buttons.length()) {
            val b = buttons.getJSONObject(i)
            val group = groups?.optJSONObject(b.optString("group", "edit"))
            val bg = parseCssColor(group?.optString("background") ?: btn.optString("background"), 0xff2e2e36.toInt())
            val accent = parseCssColor(group?.optString("borderColor") ?: btn.optString("borderColor"), 0x1affffff)
            items.add(RadialMenuView.Item(b.optString("id"), b.optString("label", b.optString("icon", "")), resolveIconBitmap(b.optString("icon", "")), bg, accent))
        }

        val cxScreen = (bubbleParams?.x ?: 0) + bubbleSize / 2f
        val cyScreen = (bubbleParams?.y ?: 0) + bubbleSize / 2f
        android.util.Log.d(
            "TouchDeck",
            "expand bubble=(${bubbleParams?.x},${bubbleParams?.y}) size=$bubbleSize cx=$cxScreen cy=$cyScreen screen=${screenW}x$screenH"
        )

        val overlay = FrameLayout(this)
        // 无遮罩：菜单直接浮在 UU 画面上。点菜单外收起由 RadialMenuView
        // 的 onDismiss 统一处理（滑选松手确认交互要求它接管全部触摸）。

        val params = WindowManager.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            ViewGroup.LayoutParams.MATCH_PARENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        )
        windowManager.addView(overlay, params)
        panelView = overlay

        // MIUI 实证：即使带 FLAG_LAYOUT_IN_SCREEN，展开层实际仍从状态栏之下开始
        // （窗口高 2530 < 物理 2670），与球窗口的全屏坐标系差一个顶部偏移。
        // 等挂载后量出真实屏幕原点，把球心换算进展开层坐标系，菜单才对心。
        overlay.post {
            if (panelView !== overlay) return@post // 已收起，丢弃
            val loc = IntArray(2)
            overlay.getLocationOnScreen(loc)
            overlayOffsetX = loc[0]
            overlayOffsetY = loc[1]
            val vcx = cxScreen - loc[0]
            val vcy = cyScreen - loc[1]
            android.util.Log.d("TouchDeck", "overlay loc=(${loc[0]},${loc[1]}) vcx=$vcx vcy=$vcy")

            val menu = RadialMenuView(
                this, vcx, vcy, items,
                onDismiss = {
                    android.util.Log.d("TouchDeck", "dismiss (release outside)")
                    collapsePanel()
                },
                onSelect = { id, label ->
                    android.util.Log.d("TouchDeck", "onSelect id=$id label=$label")
                    pressServer(id, label)
                    collapsePanel()
                }
            )
            menuView = menu
            overlay.addView(
                menu,
                FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
            )

            // 球作为轮毂重新置顶：展开时点球收起。
            // 滑选手势中（手势流还挂在球窗口上）绝不能 remove/add 球视图——
            // 重建 ViewRoot 会掐断当前触摸流，后续 MOVE/UP 全丢（2026-08-03 实证）
            if (!skipBubbleRetop) {
                bubbleView?.let { v ->
                    bubbleParams?.let { p ->
                        runCatching { windowManager.removeView(v); windowManager.addView(v, p) }
                    }
                }
            }

            // 弹性展开：缩放+淡入+轻微旋转（Overshoot 近似 spring easing）
            menu.pivotX = vcx
            menu.pivotY = vcy
            menu.scaleX = 0.5f
            menu.scaleY = 0.5f
            menu.alpha = 0f
            menu.rotation = -18f
            menu.animate().scaleX(1f).scaleY(1f).alpha(1f).rotation(0f)
                .setDuration(320).setInterpolator(OvershootInterpolator(1.5f)).start()
        }
    }

    private fun collapsePanel() {
        removePanel()
        panelExpanded = false
    }

    private fun removePanel() {
        panelView?.let { overlay -> runCatching { windowManager.removeView(overlay) } }
        panelView = null
        menuView = null
    }

    /**
     * 选中回传：仅走 P2P 直连（DataChannel，不经过任何转发）。
     * 按键注入在 Windows 端完成，本地只负责 UI 与手势。
     */
    private fun pressServer(id: String, label: String) {
        flashLabel("发送：$label")
        if (P2PState.send(id)) {
            flashLabel("已发送：$label")
        } else {
            flashLabel("P2P 未连接")
        }
    }

    /**
     * 选中反馈：MIUI/Android13 未授权通知时会静默拦截 Toast（logcat: Suppressing toast），
     * 改用自带小浮层显示，不依赖通知权限。连续触发时替换旧浮层防叠加。
     */
    private var activeFlash: android.widget.TextView? = null
    private fun flashLabel(text: String) {
        activeFlash?.let { runCatching { windowManager.removeView(it) } }
        val label = android.widget.TextView(this).apply {
            this.text = text
            setTextColor(Color.WHITE)
            textSize = 14f
            setPadding(dp(14), dp(8), dp(14), dp(8))
            background = GradientDrawable().apply {
                setColor(0xE6222226.toInt())
                cornerRadius = dp(16).toFloat()
            }
        }
        val params = WindowManager.LayoutParams(
            ViewGroup.LayoutParams.WRAP_CONTENT,
            ViewGroup.LayoutParams.WRAP_CONTENT,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
            y = dp(96)
        }
        activeFlash = label
        runCatching { windowManager.addView(label, params) }
        label.postDelayed({
            if (activeFlash === label) {
                activeFlash = null
                runCatching { windowManager.removeView(label) }
            }
        }, 900)
    }

    private fun dp(value: Int): Int =
        TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value.toFloat(), resources.displayMetrics
        ).roundToInt()
}
