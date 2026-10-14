package com.omrilotan.squidread

import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.IntentCompat
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.launch

/**
 * Entry point for the launcher icon, "Open with" and share. Imports the file it was given, if
 * any, then hands over to that book's own task and goes away.
 *
 * Other apps can start this activity with anything, so everything it is given is checked.
 */
class LauncherActivity : AppCompatActivity() {
	private val app get() = application as SquidreadApplication

	/** Imports under way; the screen stays until the last one is done. */
	private var importing = 0

	/** The book to open once they are; the others are in the library. */
	private var toOpen: String? = null
	private var title: TextView? = null

	override fun onCreate(savedInstanceState: Bundle?) {
		super.onCreate(savedInstanceState)
		handle(intent)
	}

	// Single instance: a second request while one is in progress arrives here.
	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		handle(intent)
	}

	private fun handle(intent: Intent) {
		val uri = fileFrom(intent)
		if (uri == null) {
			// The launcher icon while a file is being imported: that book opens when it is ready.
			if (importing > 0) return
			startActivity(BookTasks.intent(this, bookToOpen()))
			finish()
			return
		}

		val title = title ?: run {
			setContentView(R.layout.activity_launcher)
			findViewById<TextView>(R.id.loading_title).also { title = it }
		}
		importing++
		// The sending app's provider is asked for the file's name off the main thread; the
		// screen waits a moment for it, so it appears once, with the title.
		val name = lifecycleScope.async(Dispatchers.IO) { displayName(uri) }
		window.decorView.holdDrawing(lifecycleScope, NAME_WAIT_MS) {
			title.text = name.await()?.substringBeforeLast('.')?.let(Library::cleanTitle).orEmpty()
		}
		lifecycleScope.launch {
			// The import belongs to the app, so leaving this screen doesn't lose the book.
			// A book already in the library simply opens where it was left.
			val imported = app.library.importAsync(uri, name).await()
			if (imported == null) {
				Toast.makeText(this@LauncherActivity, R.string.open_failed, Toast.LENGTH_SHORT).show()
			} else {
				toOpen = imported.id
			}
			// Opening a book while another import runs would hide this screen, which ends it.
			if (--importing == 0) {
				toOpen?.let { startActivity(BookTasks.intent(this@LauncherActivity, it)) }
				finish()
			}
		}
	}

	/** The most recently read book, or the library after a crash or when there is none. */
	private fun bookToOpen(): String? {
		if (app.prefs.takeCrashed()) return null
		val library = app.library
		return app.prefs.lastBookId?.takeIf { library.get(it) != null }
			?: library.all().firstOrNull { !it.pendingMetadata }?.id
	}

	/** A shared document; any other kind of URI, such as a path to this app's own files, is ignored. */
	private fun fileFrom(intent: Intent?): Uri? {
		val uri = when (intent?.action) {
			Intent.ACTION_VIEW -> intent.data
			// Reading the extra can throw for a malformed intent from another app.
			Intent.ACTION_SEND -> runCatching { IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java) }.getOrNull()
			else -> null
		}
		return uri?.takeIf { it.scheme == ContentResolver.SCHEME_CONTENT }
	}

	private fun displayName(uri: Uri): String? = runCatching {
		contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
			if (cursor.moveToFirst()) cursor.getString(0) else null
		}
	}.getOrNull() ?: uri.lastPathSegment?.substringAfterLast('/')?.substringAfterLast(':')

	private companion object {
		const val NAME_WAIT_MS = 150L
	}
}
