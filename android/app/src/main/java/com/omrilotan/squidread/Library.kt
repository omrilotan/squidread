package com.omrilotan.squidread

import android.content.ContentResolver
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Process
import android.os.SystemClock
import android.util.AtomicFile
import android.util.Log
import android.util.Xml
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.util.use
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.security.DigestInputStream
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipFile

data class Book(
	val id: String,
	var title: String,
	val addedAt: Long,
	var lastOpened: Long,
	/** Last reading position, as Readium locator JSON. */
	var locator: String?,
	/** Imported but not yet opened: title is the file name and there is no cover yet. */
	var pendingMetadata: Boolean = false,
	/** The file's full SHA-256; null for books imported before it was kept. */
	val sha256: String? = null,
	/** The authors, comma separated; empty when the book names none, null until read. */
	var author: String? = null,
)

/**
 * Books live in app storage as `books/<id>.epub`, covers as `covers/<id>.png`, and the list in
 * `library.json`. The id is the first 12 hex characters of the file's SHA-256, as in the web app,
 * so importing the same file twice opens the existing copy.
 *
 * Call the public methods from the main thread; disk work runs in the background.
 */
class Library(private val context: Context, private val covers: CoverCache) {
	private val booksDir = File(context.filesDir, "books")
	private val coversDir = File(context.filesDir, "covers")
	private val indexFile = AtomicFile(File(context.filesDir, "library.json"))
	private val books: MutableMap<String, Book> by lazy { load() }

	// One writer at a time keeps saves ordered.
	@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
	private val writer = Dispatchers.IO.limitedParallelism(1)
	private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

	/** A reading position waiting to be written; positions change on every page turn. */
	private var pendingLocatorSave: Job? = null

	fun all(): List<Book> = books.values.sortedByDescending { it.lastOpened }

	fun get(id: String): Book? = books[id]

	fun file(id: String) = File(booksDir, "$id.epub")

	fun coverFile(id: String) = File(coversDir, "$id.png")

	/**
	 * Copies the file into the library. Only copies and hashes, so it is quick; the reader fills
	 * in the title and cover the first time it opens the book (see [completeMetadata]).
	 *
	 * Runs for the life of the app, so leaving the screen that asked for it doesn't lose the book.
	 * [displayName] is awaited only once the copy is done.
	 */
	fun importAsync(uri: Uri, displayName: Deferred<String?>): Deferred<Book?> = scope.async {
		import(uri, displayName)
	}

	private suspend fun import(uri: Uri, displayName: Deferred<String?>): Book? {
		// Only documents other apps share; never a path to this app's own private files.
		if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
		sweepTempFiles()
		val copied = copyToTemp(uri) ?: return null

		// From here on the book is either fully added or not at all.
		return withContext(NonCancellable) commit@{
			// The sending app's provider is asked for the name; one that never answers mustn't hold
			// the import. The reader takes the title from the book anyway.
			val name = withTimeoutOrNull(NAME_TIMEOUT_MS) {
				try {
					displayName.await()
				} catch (error: CancellationException) {
					null
				}
			}
			val id = idFor(copied.sha256)
			books[id]?.let { existing ->
				withContext(Dispatchers.IO) { copied.file.delete() }
				return@commit existing
			}

			val stored = withContext(Dispatchers.IO) {
				try {
					booksDir.mkdirs()
					val target = file(id)
					if (!copied.file.renameTo(target)) {
						copied.file.copyTo(target, overwrite = true)
						copied.file.delete()
					}
					true
				} catch (error: IOException) {
					Log.w(TAG, "Cannot store book: ${error.javaClass.simpleName}")
					copied.file.delete()
					file(id).delete()
					false
				}
			}
			if (!stored) return@commit null
			// Another import of the same file may have finished while this one was copying.
			books[id]?.let { return@commit it }

			val now = System.currentTimeMillis()
			val title = cleanTitle(name?.substringBeforeLast('.')) ?: UNTITLED
			val book = Book(id, title, addedAt = now, lastOpened = now, locator = null, pendingMetadata = true, sha256 = copied.sha256)
			books[id] = book
			save()
			book
		}
	}

	/**
	 * The short id for a file, or a longer one when a different file already has it (two files
	 * sharing 48 bits of their hash is unlikely by chance, but can be made on purpose).
	 */
	private fun idFor(sha256: String): String = ID_LENGTHS.map { sha256.take(it) }.first { id ->
		val existing = books[id]
		existing == null || existing.sha256 == null || existing.sha256 == sha256
	}

	/** Takes the title and cover from the opened publication, once per imported book. */
	suspend fun completeMetadata(book: Book, publication: Publication) {
		if (!book.pendingMetadata) return
		withContext(Dispatchers.IO) {
			coversDir.mkdirs()
			saveCover(book.id, publication)
		}
		covers.remove(book.id)
		cleanTitle(publication.metadata.title)?.let { book.title = it }
		book.author = authorOf(publication)
		book.pendingMetadata = false
		save()
	}

	/**
	 * Reads the authors of books added before they were kept, from each book's package document
	 * rather than opening it whole. Returns whether any book changed.
	 */
	suspend fun completeAuthors(): Boolean {
		val missing = books.values.filter { it.author == null && !it.pendingMetadata }
		if (missing.isEmpty()) return false
		val found = withContext(Dispatchers.IO) { missing.associate { it.id to readAuthor(file(it.id)) } }
		found.forEach { (id, author) -> books[id]?.let { if (it.author == null) it.author = author } }
		save()
		return true
	}

	fun touch(id: String) {
		books[id]?.lastOpened = System.currentTimeMillis()
		save()
	}

	/** Positions are written a moment later, together; [flush] writes a pending one right away. */
	fun saveLocator(id: String, locator: String) {
		val book = books[id] ?: return
		if (book.locator == locator) return
		book.locator = locator
		if (pendingLocatorSave?.isActive == true) return
		pendingLocatorSave = scope.launch {
			delay(LOCATOR_SAVE_DELAY_MS)
			pendingLocatorSave = null
			save()
		}
	}

	fun flush() {
		if (pendingLocatorSave?.isActive == true) save()
	}

	fun delete(id: String) {
		books.remove(id) ?: return
		covers.remove(id)
		save()
		scope.launch(writer) {
			file(id).delete()
			coverFile(id).delete()
		}
	}

	private class Copied(val sha256: String, val file: File)

	private var swept = false

	/**
	 * Deletes copies left by imports the system cut short by ending the process, once per process.
	 * Only files from before this process started, so none in use.
	 */
	private fun sweepTempFiles() {
		if (swept) return
		swept = true
		val started = System.currentTimeMillis() - SystemClock.elapsedRealtime() + Process.getStartElapsedRealtime()
		scope.launch(writer) {
			context.cacheDir.listFiles { file -> file.name.startsWith(TEMP_PREFIX) && file.lastModified() < started }
				?.forEach { it.delete() }
			// And rewrites of books with repeated entries; see dropDuplicateEntries.
			booksDir.listFiles { file -> file.name.endsWith(".tmp") && file.lastModified() < started }
				?.forEach { it.delete() }
		}
	}

	/** Copies [uri] to a temporary file and hashes it on the way; null if it can't be a book. */
	private suspend fun copyToTemp(uri: Uri): Copied? = withContext(Dispatchers.IO) {
		val temp = File(context.cacheDir, "$TEMP_PREFIX${System.nanoTime()}.epub")
		var kept = false
		try {
			val digest = MessageDigest.getInstance("SHA-256")
			val input = context.contentResolver.openInputStream(uri) ?: return@withContext null
			DigestInputStream(input, digest).use { stream ->
				temp.outputStream().use { output ->
					// Bounded, so a source that never ends can't fill the device.
					val buffer = ByteArray(BUFFER_SIZE)
					var total = 0L
					if (temp.usableSpace < MIN_FREE_BYTES) throw IOException("Low on storage")
					while (true) {
						ensureActive()
						val count = stream.read(buffer)
						if (count < 0) break
						total += count
						if (total > MAX_IMPORT_BYTES) throw IOException("Too large")
						// Other apps can send files without asking; never fill the device.
						if (total % SPACE_CHECK_BYTES < count && temp.usableSpace < MIN_FREE_BYTES) {
							throw IOException("Low on storage")
						}
						output.write(buffer, 0, count)
					}
				}
			}
			if (!isPlausibleArchive(temp)) {
				Log.w(TAG, "Not a readable archive")
				return@withContext null
			}
			kept = true
			Copied(digest.digest().joinToString("") { "%02x".format(it) }, temp)
		} catch (error: CancellationException) {
			throw error
		} catch (error: Exception) {
			// The URI usually names the file; keep it out of the log.
			Log.w(TAG, "Cannot read ${uri.scheme}://${uri.authority}: ${error.javaClass.simpleName}")
			null
		} finally {
			if (!kept) temp.delete()
		}
	}

	/**
	 * Rejects archives whose entries claim to be larger than the archive itself, which is
	 * impossible in a real file. Readium sizes its page positions from those claims, so a forged
	 * one would run the reader out of memory every time the book opened. Also rejects entries that
	 * unpack to more than any chapter or picture needs, which only an archive built to expand
	 * without end has. Reads only the archive's directory. Archives java.util.zip can't read at
	 * all are left for Readium to judge.
	 */
	private fun isPlausibleArchive(file: File): Boolean = try {
		val limit = file.length()
		ZipFile(file).use { zip ->
			zip.entries().asSequence().all { entry ->
				entry.compressedSize in 0..limit &&
					(entry.method != ZipEntry.STORED || entry.size in 0..limit) &&
					entry.size <= MAX_ENTRY_BYTES
			}
		}
	} catch (error: IOException) {
		true
	}

	/**
	 * Decodes the cover at a reduced size: a cover image can be far larger than the library
	 * needs, or built to exhaust memory when decoded whole.
	 */
	private suspend fun saveCover(id: String, publication: Publication) {
		try {
			val link = publication.linkWithRel("cover") ?: return
			val bytes = publication.get(link)?.use { resource ->
				if ((resource.length().getOrNull() ?: 0L) > MAX_COVER_BYTES) null else resource.read().getOrNull()
			} ?: return
			val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
			BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
			if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return
			var sample = 1
			while (bounds.outWidth / (sample * 2) >= COVER_WIDTH && bounds.outHeight / (sample * 2) >= COVER_HEIGHT) sample *= 2
			if ((bounds.outWidth / sample).toLong() * (bounds.outHeight / sample) > MAX_COVER_PIXELS) return
			val decoded = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample })
				?: return
			val scale = minOf(COVER_WIDTH.toFloat() / decoded.width, COVER_HEIGHT.toFloat() / decoded.height, 1f)
			val cover = if (scale < 1f) {
				Bitmap.createScaledBitmap(decoded, (decoded.width * scale).toInt().coerceAtLeast(1), (decoded.height * scale).toInt().coerceAtLeast(1), true)
			} else {
				decoded
			}
			coverFile(id).outputStream().use { cover.compress(Bitmap.CompressFormat.PNG, 100, it) }
		} catch (error: CancellationException) {
			throw error
		} catch (error: Exception) {
			Log.w(TAG, "Cannot save cover for $id: ${error.javaClass.simpleName}")
		} catch (error: OutOfMemoryError) {
			Log.w(TAG, "Cover too large for $id")
		}
	}

	private fun save() {
		pendingLocatorSave?.cancel()
		pendingLocatorSave = null
		// Copies are cheap; building the JSON and writing it happen on the writer thread.
		val snapshot = books.values.map { it.copy() }
		scope.launch(writer) {
			val bytes = toJson(snapshot).toByteArray()
			var stream: FileOutputStream? = null
			try {
				stream = indexFile.startWrite()
				stream.write(bytes)
				indexFile.finishWrite(stream)
			} catch (error: IOException) {
				stream?.let(indexFile::failWrite)
				Log.w(TAG, "Cannot save library: ${error.javaClass.simpleName}")
			}
		}
	}

	private fun toJson(snapshot: List<Book>): String = JSONArray().apply {
		snapshot.forEach { book ->
			put(
				JSONObject()
					.put("id", book.id)
					.put("title", book.title)
					.put("addedAt", book.addedAt)
					.put("lastOpened", book.lastOpened)
					.put("locator", book.locator)
					.put("pendingMetadata", book.pendingMetadata)
					.put("sha256", book.sha256)
					.put("author", book.author),
			)
		}
	}.toString()

	private fun load(): MutableMap<String, Book> {
		val result = LinkedHashMap<String, Book>()
		if (!indexFile.baseFile.exists()) return result
		val array = try {
			JSONArray(String(indexFile.readFully()))
		} catch (error: Exception) {
			// Keep the unreadable list aside, so the next save can't overwrite the only copy.
			Log.w(TAG, "Cannot load library: ${error.javaClass.simpleName}")
			indexFile.baseFile.renameTo(File(context.filesDir, "library.json.bad"))
			return result
		}
		// One damaged entry loses that book only.
		for (index in 0 until array.length()) {
			val item = array.optJSONObject(index) ?: continue
			val book = try {
				Book(
					id = item.getString("id"),
					title = cleanTitle(item.getString("title")) ?: UNTITLED,
					addedAt = item.getLong("addedAt"),
					lastOpened = item.getLong("lastOpened"),
					locator = item.optString("locator").takeIf { it.isNotEmpty() },
					pendingMetadata = item.optBoolean("pendingMetadata"),
					sha256 = item.optString("sha256").takeIf { SHA256.matches(it) },
					author = if (item.has("author")) cleanTitle(item.optString("author")).orEmpty() else null,
				)
			} catch (error: JSONException) {
				continue
			}
			if (ID.matches(book.id) && file(book.id).exists()) result[book.id] = book
		}
		return result
	}

	companion object {
		private const val TAG = "Squidread"
		private const val UNTITLED = "Untitled"
		private const val TEMP_PREFIX = "import-"
		private const val NAME_TIMEOUT_MS = 2_000L
		private const val BUFFER_SIZE = 64 * 1024
		private const val MAX_IMPORT_BYTES = 1L shl 30
		private const val MAX_ENTRY_BYTES = 256L shl 20
		private const val MIN_FREE_BYTES = 256L shl 20
		private const val SPACE_CHECK_BYTES = 16L shl 20
		private const val COVER_WIDTH = 300
		private const val COVER_HEIGHT = 450
		private const val MAX_COVER_BYTES = 20L shl 20
		private const val MAX_COVER_PIXELS = 16_000_000L
		private const val LOCATOR_SAVE_DELAY_MS = 2_000L
		private const val MAX_TITLE_LENGTH = 500
		private val ID_LENGTHS = listOf(12, 20, 64)
		private val ID = Regex("[0-9a-f]{12,64}")
		private val SHA256 = Regex("[0-9a-f]{64}")
		private val CONTROLS_AND_SPACES = Regex("[\\p{Cntrl}\\s]+")

		/**
		 * A title fit to show and store: on one line, and not so long that it slows saving or
		 * overflows the system's task label. Titles come from files, so they can be anything.
		 */
		fun cleanTitle(title: String?): String? {
			val clean = title?.replace(CONTROLS_AND_SPACES, " ")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
			if (clean.length <= MAX_TITLE_LENGTH) return clean
			val end = if (clean[MAX_TITLE_LENGTH - 1].isHighSurrogate()) MAX_TITLE_LENGTH - 1 else MAX_TITLE_LENGTH
			return clean.take(end)
		}

		private fun authorOf(publication: Publication) =
			cleanTitle(publication.metadata.authors.joinToString(", ") { it.name }).orEmpty()

		/**
		 * The authors named in the package document: its creators, less those whose role says
		 * they are not the author (an editor or illustrator). Empty when there are none or the
		 * file can't be read; books come from anywhere, so nothing here may throw.
		 */
		private fun readAuthor(file: File): String = try {
			ZipFile(file).use { zip ->
				val container = zip.readSmall(CONTAINER_PATH) ?: return@use ""
				val packagePath = parse(container) { parser, found ->
					if (parser.name == "rootfile") parser.getAttributeValue(null, "full-path")?.let(found)
				}.firstOrNull() ?: return@use ""
				val document = zip.readSmall(packagePath) ?: return@use ""
				val creators = parse(document) { parser, found ->
					if (parser.name == "creator" && parser.namespace == DC_NAMESPACE) {
						val role = (0 until parser.attributeCount)
							.firstOrNull { parser.getAttributeName(it) == "role" }
							?.let(parser::getAttributeValue)
						val name = parser.nextText()
						if (role == null || role == "aut") found(name)
					}
				}
				cleanTitle(creators.mapNotNull(::cleanTitle).joinToString(", ")).orEmpty()
			}
		} catch (error: Exception) {
			""
		}

		private fun ZipFile.readSmall(path: String): ByteArray? {
			val entry = getEntry(path) ?: return null
			if (entry.size !in 0..MAX_PACKAGE_BYTES) return null
			return getInputStream(entry).use { it.readBytes() }
		}

		/** Calls [onStart] at each element's start; it reports what it finds through its second argument. */
		private fun parse(bytes: ByteArray, onStart: (XmlPullParser, (String) -> Unit) -> Unit): List<String> {
			val found = mutableListOf<String>()
			val parser = Xml.newPullParser()
			parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true)
			parser.setInput(bytes.inputStream(), null)
			while (parser.next() != XmlPullParser.END_DOCUMENT) {
				if (parser.eventType == XmlPullParser.START_TAG) onStart(parser) { found += it }
			}
			return found
		}

		private const val CONTAINER_PATH = "META-INF/container.xml"
		private const val DC_NAMESPACE = "http://purl.org/dc/elements/1.1/"
		private const val MAX_PACKAGE_BYTES = 4L shl 20
	}
}
