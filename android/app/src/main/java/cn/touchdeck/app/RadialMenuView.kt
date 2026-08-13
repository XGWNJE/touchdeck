package cn.touchdeck.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.TypedValue
import android.view.MotionEvent
import android.view.View
import java.util.UUID
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * 自适应边缘感知径向菜单（Adaptive Edge-Aware Radial Menu）：
 * 按轮毂（悬浮球）位置选择展开形态——四角 90° 扇形（开口朝屏幕中心）、
 * 四边 180° 半圆（朝向内侧）、中心区域 360° 整圆。
 *
 * 布局规则（2026-08-03 定稿）：
 * 每个按钮的展示面积全场景相等——按钮弧长 L 与环厚 T 是固定 dp 常量，
 * 每环槽位数 = round(展开角 × 环中半径 ÷ L)（屏幕越大每环自然放越多）。
 * 槽位逐个做完整可见性检查（扇区四角+内外弧中点全在屏内才可用），被屏幕边缘挡住的槽位跳过、
 * 按钮顺延到下一个可见槽位——裁掉的是环上的角度，不是按键；
 * 逐环外扩直到所有按键落位（某环一个可见槽位都没有时停止；仍有丢弃则日志告警）。
 * 支持点按与按住滑动扫选。
 */
class RadialMenuView(
    context: Context,
    private val cx: Float,
    private val cy: Float,
    private val items: List<Item>,
    viewW: Float = 0f,
    viewH: Float = 0f,
    private val onDismiss: () -> Unit,
    private val onArmed: (id: String, label: String) -> Unit,
    private val onSelect: (id: String, label: String) -> Unit,
    private val onHoldBegin: (id: String, label: String, interactionId: String) -> Unit,
    private val onHoldEnd: (id: String, label: String, interactionId: String) -> Unit
) : View(context) {

    data class Item(
        val id: String,
        val label: String,
        val icon: Bitmap?,
        val colorBg: Int,
        val colorAccent: Int,
        val aux: Boolean = false,
        val triggerMode: String = "tap"
    )

    /** 一个落位的扇区：环半径区间 + 角度区间 + 占据它的按键 */
    private class Slot(val inner: Float, val outer: Float, val a0: Float, val a1: Float, val item: Item)

    // MIUI 展开层从状态栏之下开始（比物理屏矮一截），真实可视高由 BubbleService 挂好后传入；
    // 未传入回退 displayMetrics（此时底部判定会偏松）
    private val screenW = if (viewW > 0f) viewW else resources.displayMetrics.widthPixels.toFloat()
    private val screenH = if (viewH > 0f) viewH else resources.displayMetrics.heightPixels.toFloat()

    private fun dp(v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

    private val startAngle: Float
    private val sweepAngle: Float
    private var pressedIndex = -1
    private var triggerRunnable: Runnable? = null
    private var tapArmedIndex = -1
    private var holdInteractionId: String? = null
    private var holdBegun = false
    private val slots = ArrayList<Slot>()

    companion object {
        // 滑选经过扇区时必须稳定停留后才武装；同时适用于 tap 与 hold。
        // 450ms 是首轮偏保守真机值，后续按 Owner 手感调整。
        private const val TRIGGER_ARM_DELAY_MS = 450L
    }

    private fun cancelTriggerTimer() {
        triggerRunnable?.let { removeCallbacks(it) }
        triggerRunnable = null
    }

    private fun armTrigger(index: Int) {
        cancelTriggerTimer()
        tapArmedIndex = -1
        if (index !in slots.indices) return
        val runnable = Runnable {
            triggerRunnable = null
            if (pressedIndex != index) return@Runnable
            val item = slots[index].item
            onArmed(item.id, item.label)
            if (item.triggerMode != "hold") {
                tapArmedIndex = index
                android.util.Log.d("TouchDeck", "armed tap index=$index id=${item.id}")
                return@Runnable
            }
            if (holdBegun) return@Runnable
            val interactionId = UUID.randomUUID().toString()
            holdInteractionId = interactionId
            holdBegun = true
            android.util.Log.d("TouchDeck", "armed hold index=$index id=${item.id}")
            onHoldBegin(item.id, item.label, interactionId)
        }
        triggerRunnable = runnable
        postDelayed(runnable, TRIGGER_ARM_DELAY_MS)
    }

    /** 幂等结束：滑出、取消、视图移除和 Service 销毁都可以安全调用。 */
    fun cancelActiveHold() {
        cancelTriggerTimer()
        tapArmedIndex = -1
        val interactionId = holdInteractionId
        val item = if (holdBegun && pressedIndex in slots.indices) slots[pressedIndex].item else null
        holdBegun = false
        holdInteractionId = null
        if (item != null && interactionId != null) onHoldEnd(item.id, item.label, interactionId)
    }

    private fun updatePressed(index: Int) {
        if (index == pressedIndex) return
        cancelActiveHold()
        pressedIndex = index
        armTrigger(index)
        invalidate()
    }

    init {
        // 展开区域判定（画布角度：0°=正右，顺时针为正）
        val edgePad = dp(100f)
        val left = cx < edgePad
        val right = cx > screenW - edgePad
        val top = cy < edgePad
        val bottom = cy > screenH - edgePad
        val isCorner = (left || right) && (top || bottom)
        val isEdge = !isCorner && (left || right || top || bottom)

        val angles = when {
            isCorner && left && top -> 0f to 90f
            isCorner && right && top -> 90f to 90f
            isCorner && right && bottom -> 180f to 90f
            isCorner && left && bottom -> 270f to 90f
            isEdge && left -> -90f to 180f
            isEdge && right -> 90f to 180f
            isEdge && top -> 0f to 180f
            isEdge && bottom -> 180f to 180f
            else -> -90f to 360f
        }
        startAngle = angles.first
        sweepAngle = angles.second

        // 等面积分环：弧长 L、环厚 T 恒定，每环槽位数由弧长算出来
        val hubGap = dp(34f)
        val ringThick = dp(70f)
        val ringGap = dp(0f) // C 皮肤：环与环贴邻共享发丝分割线，不留缝（厚度/弧长不变，按钮面积不变）
        val arcLen = dp(108f)
        val sweepRad = Math.toRadians(sweepAngle.toDouble()).toFloat()
        val visMargin = dp(10f)

        var ring = 0
        var idx = 0
        while (idx < items.size && ring < 16) {
            val inner = hubGap + ring * (ringThick + ringGap)
            val outer = inner + ringThick
            val rMid = (inner + outer) / 2f
            val nominal = max(1, (sweepRad * rMid / arcLen).roundToInt())
            val per = sweepAngle / nominal
            var usable = 0
            for (s in 0 until nominal) {
                if (idx >= items.size) break
                val a0 = startAngle + per * s
                val a1 = a0 + per
                // 按钮完整可见：按钮内容区（图标盒+文字盒，中角方向）完整在屏内才可落位
                // （不查扇区角尖——贴角锚点楔形角尖必然越界，全扇区检查会把首环整环卡死；
                //   2026-08-05 真机 MIUI 状态栏锚点实测 0/12）；被挡槽位跳过、按键顺延外环
                if (slotButtonVisible(inner, outer, a0, a1, visMargin)) {
                    slots.add(Slot(inner, outer, a0, a1, items[idx]))
                    idx++
                    usable++
                }
            }
            // 锚点在屏外（MIUI 状态栏）时首环可能整环不可见，外环反而伸得回屏内——
            // 只有内径超过屏幕对角线（任何点都不可能可见）才真的没空间
            if (usable == 0 && inner > hypot(screenW, screenH)) break
            ring++
        }
        if (slots.size < items.size) {
            android.util.Log.w(
                "TouchDeck",
                "menu DROPPED: placed ${slots.size}/${items.size} rings=$ring start=$startAngle sweep=$sweepAngle"
            )
        } else {
            android.util.Log.d(
                "TouchDeck",
                "menu init slots=${slots.size}/${items.size} rings=$ring start=$startAngle sweep=$sweepAngle"
            )
        }
    }

    /** 按钮完整可见判定：图标盒与文字盒（中角方向，半宽 half）都完整落在屏内（含 margin） */
    private fun slotButtonVisible(inner: Float, outer: Float, a0: Float, a1: Float, margin: Float): Boolean {
        val mid = Math.toRadians(((a0 + a1) / 2f).toDouble())
        val thick = outer - inner
        val half = dp(18f) // 图标 24dp/2 + 余量；文字盒近似同量级
        val dirX = cos(mid).toFloat()
        val dirY = sin(mid).toFloat()
        for (r in floatArrayOf(inner + thick * 0.38f, inner + thick * 0.76f)) {
            val px = cx + r * dirX
            val py = cy + r * dirY
            if (px - half < margin || px + half > screenW - margin || py - half < margin || py + half > screenH - margin) return false
        }
        return true
    }

    // C 皮肤（极简发光 HUD）：发丝白线勾环与径向分割，选中扇区一道青色发光外弧；
    // 扇区黑透底提供可识别度（局部磨砂近似——悬浮窗无截屏权限做不到真毛玻璃，
    // 用户明确不要全局压暗背景，2026-08-03）
    private val cyan = 0xFF22D3EE.toInt()
    // aux 常驻键标签色：淡青，对齐 Windows 端 menu.html；普通按钮保持原浅色
    private val auxLabelColor = 0xFF67E8F9.toInt()
    private val labelColor = 0xffeeeeee.toInt()
    private val wedgePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val strokePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = dp(0.7f)
        color = 0x59FFFFFF
    }
    private val glowPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        color = cyan
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = labelColor
        textAlign = Paint.Align.CENTER
    }
    private val path = Path()

    private fun withAlpha(c: Int, a: Int) = Color.argb(a, Color.red(c), Color.green(c), Color.blue(c))

    override fun onDraw(canvas: Canvas) {
        textPaint.textSize = dp(11f)
        for (i in slots.indices) {
            val s = slots[i]
            val a0 = s.a0
            val a1 = s.a1
            // 双弧楔形扇区
            path.reset()
            path.arcTo(RectF(cx - s.outer, cy - s.outer, cx + s.outer, cy + s.outer), a0, a1 - a0)
            path.arcTo(RectF(cx - s.inner, cy - s.inner, cx + s.inner, cy + s.inner), a1, -(a1 - a0))
            path.close()
            val it = s.item
            val pressed = i == pressedIndex
            // 黑透底（65% 黑）：只压暗菜单自身区域，背景不受影响
            wedgePaint.color = 0xA6000000.toInt()
            canvas.drawPath(path, wedgePaint)
            if (pressed) {
                wedgePaint.color = withAlpha(cyan, 80)
                canvas.drawPath(path, wedgePaint)
            }
            canvas.drawPath(path, strokePaint)
            if (pressed) {
                // 青色发光外弧：硬件加速下 BlurMaskFilter 不可靠，用递宽递淡三描边近似
                val outerRect = RectF(cx - s.outer, cy - s.outer, cx + s.outer, cy + s.outer)
                glowPaint.strokeWidth = dp(9f); glowPaint.alpha = 36
                canvas.drawArc(outerRect, a0, a1 - a0, false, glowPaint)
                glowPaint.strokeWidth = dp(4.5f); glowPaint.alpha = 90
                canvas.drawArc(outerRect, a0, a1 - a0, false, glowPaint)
                glowPaint.strokeWidth = dp(2f); glowPaint.alpha = 255
                canvas.drawArc(outerRect, a0, a1 - a0, false, glowPaint)
            }

            // 图标与文字沿扇区中角摆放，文字保持水平（可读性优先）
            val mid = Math.toRadians(((a0 + a1) / 2f).toDouble())
            val dirX = cos(mid).toFloat()
            val dirY = sin(mid).toFloat()
            val thick = s.outer - s.inner
            val rIcon = s.inner + thick * 0.38f
            val rLabel = s.inner + thick * 0.76f
            it.icon?.let { bmp ->
                val size = dp(24f)
                val x = cx + dirX * rIcon - size / 2
                val y = cy + dirY * rIcon - size / 2
                canvas.drawBitmap(bmp, null, RectF(x, y, x + size, y + size), null)
            }
            // aux 常驻键标签淡青（对齐 Windows 端 menu.html），普通按钮保持原色
            textPaint.color = if (it.aux) auxLabelColor else labelColor
            canvas.drawText(it.label, cx + dirX * rLabel, cy + dirY * rLabel + dp(4f), textPaint)
        }
    }

    /** 笛卡尔 → 极坐标命中检测：逐个槽位判半径与角度（槽位即按键，屏外槽位不存在） */
    private fun hitSector(x: Float, y: Float): Int {
        val dx = x - cx
        val dy = y - cy
        val dist = hypot(dx, dy)
        val ang = Math.toDegrees(atan2(dy.toDouble(), dx.toDouble())).toFloat()
        for (i in slots.indices) {
            val s = slots[i]
            if (dist < s.inner || dist > s.outer) continue
            var rel = ang - s.a0
            while (rel < 0) rel += 360f
            while (rel >= 360f) rel -= 360f
            if (rel <= s.a1 - s.a0) return i
        }
        return -1
    }

    /** 滑选手势桥：BubbleService 转发手指位置（视图坐标），高亮跟随 */
    fun updatePointer(viewX: Float, viewY: Float) {
        val idx = hitSector(viewX, viewY)
        updatePressed(idx)
    }

    /** 滑选手势桥：松手确认。命中=触发 onSelect，落空=触发 onDismiss */
    fun releasePointer(viewX: Float, viewY: Float): Int {
        val idx = hitSector(viewX, viewY)
        android.util.Log.d("TouchDeck", "releasePointer x=$viewX y=$viewY hit=$idx")
        val item = slots.getOrNull(idx)?.item
        val tapArmed = tapArmedIndex == idx
        if (item?.triggerMode == "hold") {
            cancelActiveHold()
            onDismiss()
        } else {
            cancelActiveHold()
            if (item != null && tapArmed) onSelect(item.id, item.label) else onDismiss()
        }
        pressedIndex = -1
        invalidate()
        if (idx < 0) onDismiss()
        return idx
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // 全部触摸由本视图接管：按下即开始滑选，不按命中与否分发
                pressedIndex = hitSector(e.x, e.y)
                android.util.Log.d("TouchDeck", "DOWN x=${e.x} y=${e.y} cx=$cx cy=$cy hit=$pressedIndex")
                armTrigger(pressedIndex)
                if (pressedIndex >= 0) invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                // 滑动选择：高亮跟随手指扫过的扇区
                val idx = hitSector(e.x, e.y)
                updatePressed(idx)
                return true
            }
            MotionEvent.ACTION_UP -> {
                // 松开确认：松在扇区上=选中；松在空白=取消（收起菜单）
                val idx = hitSector(e.x, e.y)
                android.util.Log.d("TouchDeck", "UP x=${e.x} y=${e.y} hit=$idx")
                val item = slots.getOrNull(idx)?.item
                val tapArmed = tapArmedIndex == idx
                if (item?.triggerMode == "hold") {
                    cancelActiveHold()
                    onDismiss()
                } else {
                    cancelActiveHold()
                    if (item != null && tapArmed) onSelect(item.id, item.label) else onDismiss()
                }
                pressedIndex = -1
                invalidate()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                cancelActiveHold()
                pressedIndex = -1
                invalidate()
                return true
            }
        }
        return false
    }

    override fun onDetachedFromWindow() {
        cancelActiveHold()
        super.onDetachedFromWindow()
    }
}
