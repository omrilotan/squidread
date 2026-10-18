package com.omrilotan.squidread

import android.content.Context
import androidx.core.content.edit

enum class ZoneAction { PREV, MENU, NEXT }

/** Light is black on white, dark is white on black; system follows the device's dark theme. */
enum class ThemeMode { SYSTEM, LIGHT, DARK }

class ReaderPreferences(context: Context) {
	private val prefs = context.getSharedPreferences("squidread", Context.MODE_PRIVATE)

	var fontSize: Double
		get() = prefs.getFloat(FONT_SIZE, 1f).toDouble()
		set(value) = prefs.edit { putFloat(FONT_SIZE, value.toFloat()) }

	/** A family from the fonts folder to use instead of the book's fonts; null for the book's. */
	var fontFamily: String?
		get() = prefs.getString(FONT_FAMILY, null)
		set(value) = prefs.edit { putString(FONT_FAMILY, value) }

	/** The fonts folder the user granted access to, as a document tree URI. */
	var fontsFolder: String?
		get() = prefs.getString(FONTS_FOLDER, null)
		set(value) = prefs.edit { putString(FONTS_FOLDER, value) }

	/** The last listing of the fonts folder, so opening a book needn't wait for a new one. */
	var fontsCache: String?
		get() = prefs.getString(FONTS_CACHE, null)
		set(value) = prefs.edit { putString(FONTS_CACHE, value) }

	/** Row-major 3×3 grid of tap zone actions, configured for left-to-right books. */
	var zones: List<ZoneAction>
		get() {
			val stored = prefs.getString(ZONES, null)?.split(',')?.map { enumOrDefault(it, ZoneAction.MENU) }
			return stored?.takeIf { it.size == 9 } ?: DEFAULT_ZONES
		}
		set(value) = prefs.edit { putString(ZONES, value.joinToString(",") { it.name }) }

	var theme: ThemeMode
		get() = enumOrDefault(prefs.getString(THEME, null), ThemeMode.SYSTEM)
		set(value) = prefs.edit { putString(THEME, value.name) }

	var lastBookId: String?
		get() = prefs.getString(LAST_BOOK, null)
		set(value) = prefs.edit { putString(LAST_BOOK, value) }

	/** Notes that the app crashed. Written at once, since the process is about to die. */
	fun markCrashed() {
		prefs.edit(commit = true) { putBoolean(CRASHED, true) }
	}

	/** Whether the app crashed since the last call. */
	fun takeCrashed(): Boolean {
		if (!prefs.getBoolean(CRASHED, false)) return false
		prefs.edit { remove(CRASHED) }
		return true
	}

	private inline fun <reified T : Enum<T>> enumOrDefault(name: String?, default: T): T =
		enumValues<T>().firstOrNull { it.name == name } ?: default

	companion object {
		const val MIN_FONT_SIZE = 0.5
		const val MAX_FONT_SIZE = 2.0
		const val FONT_SIZE_STEP = 0.1

		private const val FONT_SIZE = "fontSize"
		private const val FONT_FAMILY = "fontFamily"
		private const val FONTS_FOLDER = "fontsFolder"
		private const val FONTS_CACHE = "fontsCache"
		private const val CRASHED = "crashed"
		private const val ZONES = "zones"
		private const val THEME = "theme"
		private const val LAST_BOOK = "lastBookId"

		val DEFAULT_ZONES = List(3) { listOf(ZoneAction.PREV, ZoneAction.MENU, ZoneAction.NEXT) }.flatten()
	}
}
