package com.omrilotan.squidread

import android.app.Application
import android.webkit.CookieManager
import android.webkit.WebSettings
import android.webkit.WebStorage
import androidx.appcompat.app.AppCompatDelegate

class SquidreadApplication : Application() {
	val prefs by lazy { ReaderPreferences(this) }
	val fonts by lazy { Fonts(this, prefs) }
	val readium by lazy { Readium(this, fonts) }
	val covers = CoverCache()
	val library by lazy { Library(this, covers) }

	/** Reader screens, least recently shown first; see [MainActivity.trimLoadedReaders]. */
	internal val readers = mutableListOf<MainActivity>()

	/** Whether [prepareWebView] has run in this process. */
	var isWebViewPrepared = false
		private set

	override fun onCreate() {
		super.onCreate()
		watchForCrashes()
		applyTheme()
	}

	/** Sets every screen to [ReaderPreferences.theme]; open ones are recreated if it changes. */
	fun applyTheme() {
		AppCompatDelegate.setDefaultNightMode(
			when (prefs.theme) {
				ThemeMode.SYSTEM -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
				ThemeMode.LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
				ThemeMode.DARK -> AppCompatDelegate.MODE_NIGHT_YES
			},
		)
	}

	/**
	 * After a crash the launcher opens the library once instead of the book, so a book that
	 * crashes the app can't lock the user out of it. The web view installs a crash handler of
	 * its own that ends the process at once, so this is installed again in front of it once the
	 * web view has started.
	 */
	fun watchForCrashes() {
		val current = Thread.getDefaultUncaughtExceptionHandler()
		if (current !is CrashMarker) Thread.setDefaultUncaughtExceptionHandler(CrashMarker(current))
	}

	private inner class CrashMarker(private val next: Thread.UncaughtExceptionHandler?) : Thread.UncaughtExceptionHandler {
		override fun uncaughtException(thread: Thread, error: Throwable) {
			runCatching { prefs.markCrashed() }
			next?.uncaughtException(thread, error)
		}
	}

	override fun onTrimMemory(level: Int) {
		super.onTrimMemory(level)
		covers.trim(level)
	}

	/**
	 * Starts the web view engine, once per process. Loading it takes a few hundred milliseconds
	 * on the main thread, so the reader does it while the book is parsed in the background,
	 * rather than afterwards when the first page view is created.
	 *
	 * Books share one web origin, so nothing a book stores may outlive it or reach another book.
	 */
	fun prepareWebView() {
		if (isWebViewPrepared) return
		isWebViewPrepared = true
		runCatching {
			WebSettings.getDefaultUserAgent(this)
			CookieManager.getInstance().apply {
				setAcceptCookie(false)
				removeAllCookies(null)
			}
			WebStorage.getInstance().deleteAllData()
		}
		watchForCrashes()
	}
}
