package com.omrilotan.squidread

import android.os.Build
import android.os.Looper
import android.view.View
import android.view.ViewTreeObserver
import androidx.core.view.doOnAttach
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Holds back drawing this view's window until [ready] finishes or [timeoutMs] pass, so a screen
 * whose content arrives a moment later (a cover, a title) appears once, complete. On e-ink every
 * extra frame is a visible refresh. [ready] keeps running past the timeout.
 */
fun View.holdDrawing(scope: CoroutineScope, timeoutMs: Long, ready: suspend () -> Unit): Job {
	var released = false
	val listener = object : ViewTreeObserver.OnPreDrawListener {
		override fun onPreDraw(): Boolean {
			if (!released) return false
			// The observer may have changed since this was added, when the view was attached.
			viewTreeObserver.removeOnPreDrawListener(this)
			return true
		}
	}
	viewTreeObserver.addOnPreDrawListener(listener)
	val work = scope.launch { ready() }
	return scope.launch {
		try {
			withTimeoutOrNull(timeoutMs) { work.join() }
		} finally {
			released = true
			invalidate()
		}
	}
}

/** Runs [action] on the main thread once the next frame of this view's window is on screen. */
fun View.afterNextFrame(action: () -> Unit) {
	if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
		// The commit callback runs at the front of the queue; posting lets the window manager
		// learn about the frame first.
		doOnAttach { view -> view.viewTreeObserver.registerFrameCommitCallback { view.post(action) } }
	} else {
		Looper.myQueue().addIdleHandler {
			post(action)
			false
		}
	}
}
