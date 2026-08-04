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
 * 槽位逐个做可见性检查（扇区中点落在屏内才可用），被屏幕边缘挡住的槽位跳过、
 * 按钮顺延到下一个可见槽位——裁掉的是环上的角度，不是按键；
 * 逐环外扩直到所有按键落位（某环一个可见槽位都没有时停止）。
 * 支持点按与按住滑动扫选。
 */
class RadialMenuView(
    context: Context,
    private val cx: Float,
    private val cy: Float,
    private val items: List<Item>,
    private val onDismiss: () -> Unit,
    private val onSelect: (id: String, label: String) -> Unit
) : View(context) {

    data class Item(val id: String, val label: String, val icon: Bitmap?, val colorBg: Int, val colorAccent: Int)

    /** 一个落位的扇区：环半径区间 + 角度区间 + 占据它的按键 */
    private class Slot(val inner: Float, val outer: Float, val a0: Float, val a1: Float, val item: Item)

    private val screenW = resources.displayMetrics.widthPixels.toFloat()
    private val screenH = resources.displayMetrics.heightPixels.toFloat()

    private fun dp(v: Float): Float =
        TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)

    private val startAngle: Float
    private val sweepAngle: Float
    private var pressedIndex = -1
    private val slots = ArrayList<Slot>()

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
                // 可见性：扇区中点（图标位）落在屏内才算可用槽位，被挡的跳过、按键顺延
                val mid = Math.toRadians(((a0 + a1) / 2f).toDouble())
                val px = cx + (rMid * cos(mid)).toFloat()
                val py = cy + (rMid * sin(mid)).toFloat()
                if (px >= visMargin && px <= screenW - visMargin && py >= visMargin && py <= screenH - visMargin) {
                    slots.add(Slot(inner, outer, a0, a1, items[idx]))
                    idx++
                    usable++
                }
            }
            // 这一环一个槽位都露不出来，再往外更不可能——空间真的用完了
            if (usable == 0) break
            ring++
        }
        android.util.Log.d(
            "TouchDeck",
            "menu init slots=${slots.size}/${items.size} rings=$ring start=$startAngle sweep=$sweepAngle"
        )
    }

    // C 皮肤（极简发光 HUD）：发丝白线勾环与径向分割，选中扇区一道青色发光外弧；
    // 扇区黑透底提供可识别度（局部磨砂近似——悬浮窗无截屏权限做不到真毛玻璃，
    // 用户明确不要全局压暗背景，2026-08-03）
    private val cyan = 0xFF22D3EE.toInt()
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
        color = 0xffeeeeee.toInt()
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
        if (idx != pressedIndex) {
            pressedIndex = idx
            invalidate()
        }
    }

    /** 滑选手势桥：松手确认。命中=触发 onSelect，落空=触发 onDismiss */
    fun releasePointer(viewX: Float, viewY: Float): Int {
        val idx = hitSector(viewX, viewY)
        android.util.Log.d("TouchDeck", "releasePointer x=$viewX y=$viewY hit=$idx")
        pressedIndex = -1
        invalidate()
        if (idx >= 0) onSelect(slots[idx].item.id, slots[idx].item.label) else onDismiss()
        return idx
    }

    override fun onTouchEvent(e: MotionEvent): Boolean {
        when (e.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                // 全部触摸由本视图接管：按下即开始滑选，不按命中与否分发
                pressedIndex = hitSector(e.x, e.y)
                android.util.Log.d("TouchDeck", "DOWN x=${e.x} y=${e.y} cx=$cx cy=$cy hit=$pressedIndex")
                if (pressedIndex >= 0) invalidate()
                return true
            }
            MotionEvent.ACTION_MOVE -> {
                // 滑动选择：高亮跟随手指扫过的扇区
                val idx = hitSector(e.x, e.y)
                if (idx != pressedIndex) {
                    pressedIndex = idx
                    invalidate()
                }
                return true
            }
            MotionEvent.ACTION_UP -> {
                // 松开确认：松在扇区上=选中；松在空白=取消（收起菜单）
                val idx = hitSector(e.x, e.y)
                android.util.Log.d("TouchDeck", "UP x=${e.x} y=${e.y} hit=$idx")
                if (idx >= 0) onSelect(slots[idx].item.id, slots[idx].item.label) else onDismiss()
                pressedIndex = -1
                invalidate()
                return true
            }
            MotionEvent.ACTION_CANCEL -> {
                pressedIndex = -1
                invalidate()
                return true
            }
        }
        return false
    }
}
