package com.omrilotan.squidread

import android.content.ComponentCallbacks2
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.LruCache
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.launch
import java.io.File

/**
 * Decoded library covers, shared by every book task in the process, so a cover the library has
 * shown appears at once on the loading screen and in other tasks.
 *
 * Call from the main thread.
 */
class CoverCache {
	private val cache = object : LruCache<String, Bitmap>(MAX_BYTES) {
		override fun sizeOf(key: String, value: Bitmap) = value.allocationByteCount
	}

	// A few at a time, so scrolling the library doesn't start dozens of decodes at once.
	@OptIn(ExperimentalCoroutinesApi::class)
	private val decoder = Dispatchers.IO.limitedParallelism(2)

	// Decodes outlive whoever asked first: a recycled library tile, say, while the loading
	// screen waits for the same cover.
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
	private val decoding = HashMap<String, Deferred<Bitmap?>>()

	fun cached(id: String): Bitmap? = cache.get(id)

	/** The cover from the cache, or decoded from [file]; null when the book has none. */
	suspend fun load(id: String, file: File): Bitmap? {
		cache.get(id)?.let { return it }
		val decode = decoding[id] ?: scope.async(decoder) {
			if (file.exists()) BitmapFactory.decodeFile(file.path)?.also { cache.put(id, it) } else null
		}.also { deferred ->
			decoding[id] = deferred
			deferred.invokeOnCompletion { scope.launch { if (decoding[id] === deferred) decoding.remove(id) } }
		}
		return decode.await()
	}

	fun remove(id: String) {
		decoding.remove(id)
		cache.remove(id)
	}

	/** Dropping covers makes the library fill in one refresh at a time; only when memory is really short. */
	fun trim(level: Int) {
		if (evicts(level)) cache.evictAll()
	}

	companion object {
		fun evicts(level: Int) =
			level >= ComponentCallbacks2.TRIM_MEMORY_COMPLETE || level == ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL

		// About 30 covers at the library's 300×450.
		private const val MAX_BYTES = 16 * 1024 * 1024
	}
}
