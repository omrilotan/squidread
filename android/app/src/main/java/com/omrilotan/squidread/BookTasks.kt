package com.omrilotan.squidread

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.net.Uri

/**
 * Each book reads in its own task (a "document" in Android's recents), so open books appear as
 * separate entries in the app switcher. A task is identified by its intent's data URI:
 * `squidread://book/<id>` for a book, `squidread://library` for the library with no book open.
 */
object BookTasks {
	private const val SCHEME = "squidread"
	private const val BOOK = "book"
	private val LIBRARY: Uri = Uri.parse("$SCHEME://library")

	/** Opens the book's task, or brings it forward if it already exists. */
	fun intent(context: Context, bookId: String?): Intent =
		Intent(context, MainActivity::class.java)
			.setData(bookId?.let { Uri.Builder().scheme(SCHEME).authority(BOOK).appendPath(it).build() } ?: LIBRARY)
			.addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT)

	fun bookId(intent: Intent?): String? =
		intent?.data?.takeIf { it.scheme == SCHEME && it.host == BOOK }?.lastPathSegment

	/** Closes and removes the task reading [bookId], if there is one. */
	fun remove(context: Context, bookId: String) {
		// A task can disappear between listing and asking about it; the system then throws.
		context.getSystemService(ActivityManager::class.java).appTasks
			.firstOrNull { task -> runCatching { bookId(task.taskInfo?.baseIntent) }.getOrNull() == bookId }
			?.let { task -> runCatching { task.finishAndRemoveTask() } }
	}
}
