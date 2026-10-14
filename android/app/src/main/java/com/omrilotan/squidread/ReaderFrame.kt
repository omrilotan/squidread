package com.omrilotan.squidread

import android.content.Context
import android.util.AttributeSet
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.FrameLayout
import kotlin.math.abs

/**
 * The reading area above the footer. Remembers where the last touch started, so tap zones can be
 * computed in its coordinates whether the tap landed on the book or around it.
 */
class ReaderFrame(context: Context, attrs: AttributeSet?) : FrameLayout(context, attrs) {
	/** Called for taps that no child handled, e.g. while no book is open. */
	var onBackgroundTap: ((x: Float, y: Float) -> Unit)? = null

	/**
	 * Called once for a horizontal swipe, when the finger lifts. While set, swipes never reach
	 * the book, which would otherwise drag the page and animate it into place: many e-ink
	 * refreshes where a tap takes one.
	 */
	var onSwipe: ((leftward: Boolean) -> Unit)? = null

	/**
	 * Sees keys before Android does anything with them, as long as the reader has focus;
	 * returns whether it handled the key. After a touch, Android would otherwise spend the first
	 * page-button press on leaving touch mode, and the page wouldn't turn.
	 */
	var onKey: ((KeyEvent) -> Boolean)? = null

	var lastDownX = 0f
		private set
	var lastDownY = 0f
		private set

	/** Touches that ended on the reader where they began. A tap reported by the book must follow one. */
	var upCount = 0
		private set

	/** When the last touch ended, in [android.os.SystemClock.uptimeMillis] time. */
	var lastUpTime = 0L
		private set

	private val touchSlop = ViewConfiguration.get(context).scaledTouchSlop
	private val longPressTimeout = ViewConfiguration.getLongPressTimeout()

	// Readium's own threshold for a page-turning fling.
	private val minSwipe = 25 * resources.displayMetrics.density
	private var swiping = false

	override fun dispatchTouchEvent(event: MotionEvent): Boolean {
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> {
				lastDownX = event.x
				lastDownY = event.y
			}
			MotionEvent.ACTION_UP -> {
				// Before the swipe state is cleared: a swipe or a drag can't be a tap.
				if (!swiping && abs(event.x - lastDownX) <= touchSlop && abs(event.y - lastDownY) <= touchSlop) upCount++
				lastUpTime = event.eventTime
			}
		}
		return super.dispatchTouchEvent(event)
	}

	override fun onInterceptTouchEvent(event: MotionEvent): Boolean {
		when (event.actionMasked) {
			MotionEvent.ACTION_DOWN -> swiping = false
			MotionEvent.ACTION_MOVE -> if (!swiping && onSwipe != null && event.pointerCount == 1 &&
				// A long press then drag selects text; leave that to the book.
				event.eventTime - event.downTime < longPressTimeout
			) {
				val dx = event.x - lastDownX
				val dy = event.y - lastDownY
				// The web view scrolls past the same slop, and Readium's pager past twice it, so
				// taking the gesture here cancels it for them before the page moves.
				if (dx * dx + dy * dy > touchSlop * touchSlop && abs(dx) > abs(dy)) swiping = true
			}
		}
		return swiping
	}

	override fun onTouchEvent(event: MotionEvent): Boolean {
		if (swiping) {
			when (event.actionMasked) {
				MotionEvent.ACTION_UP -> {
					swiping = false
					val dx = event.x - lastDownX
					if (abs(dx) >= minSwipe) onSwipe?.invoke(dx < 0)
				}
				MotionEvent.ACTION_CANCEL -> swiping = false
			}
			return true
		}
		if (event.actionMasked == MotionEvent.ACTION_UP &&
			abs(event.x - lastDownX) < touchSlop &&
			abs(event.y - lastDownY) < touchSlop
		) {
			performClick()
			onBackgroundTap?.invoke(event.x, event.y)
		}
		return true
	}

	override fun dispatchKeyEventPreIme(event: KeyEvent): Boolean =
		onKey?.invoke(event) == true || super.dispatchKeyEventPreIme(event)

	override fun performClick(): Boolean = super.performClick()
}
