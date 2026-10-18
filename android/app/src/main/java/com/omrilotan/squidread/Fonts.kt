package com.omrilotan.squidread

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Log
import android.util.LruCache
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.readium.r2.navigator.epub.EpubNavigatorFragment
import org.readium.r2.navigator.epub.css.FontStyle
import org.readium.r2.navigator.epub.css.FontWeight
import org.readium.r2.navigator.preferences.FontFamily
import org.readium.r2.shared.ExperimentalReadiumApi
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.Url
import org.readium.r2.shared.util.use
import org.readium.r2.shared.util.content.ContentResource
import org.readium.r2.shared.util.data.Container
import org.readium.r2.shared.util.resource.InMemoryResource
import org.readium.r2.shared.util.resource.Resource

class FontFace(
	val family: String,
	val fileName: String,
	val uri: Uri,
	val weight: FontWeight,
	val italic: Boolean,
	/** In bytes, when the folder reports it. */
	val size: Long?,
)

class FontChoice(val family: String, val faces: List<FontFace>)

/**
 * Fonts the reader can use instead of the book's own, read from a folder on the device (by
 * default `fonts` at the root of the internal storage, where e-ink readers keep theirs).
 *
 * Android only lets the app read that folder once the user grants access to it through the
 * system folder picker; the grant is remembered. Font files are grouped into families by their
 * names, so `Literata-Bold.ttf` and `Literata-Italic.ttf` become the bold and italic of Literata.
 *
 * Books load the fonts through the publication itself ([wrap]), so they come from the same
 * origin as the book's own resources.
 */
class Fonts(private val context: Context, private val prefs: ReaderPreferences) {
	/** The families found by the last [scan], or remembered from it; empty until then. */
	@Volatile
	var families: List<FontChoice> = emptyList()
		private set

	@Volatile
	private var files: Map<String, FontFace> = emptyMap()

	/** Whether the folder was listed in this process; [restore] only recalls the last listing. */
	private var scanned = false
	private var restored = false

	/** Whether the app may read the folder, as last checked. Asking the system is a binder call. */
	@Volatile
	private var access: Boolean? = null

	/** Font files the web views asked for, so each one is read from the folder only once. */
	private val bytes = object : LruCache<String, ByteArray>(MAX_CACHED_BYTES) {
		override fun sizeOf(key: String, value: ByteArray) = value.size
	}

	val folder: Uri? get() = prefs.fontsFolder?.let(Uri::parse)

	/** The folder's name as the user sees it, such as `fonts`. */
	val folderName: String
		get() = folder
			?.let { runCatching { DocumentsContract.getTreeDocumentId(it) }.getOrNull() }
			?.substringAfterLast(':')
			?.substringAfterLast('/')
			?.takeIf { it.isNotEmpty() }
			?: DEFAULT_FOLDER

	/** Where the folder picker starts: the `fonts` folder at the root of the internal storage. */
	val initialFolder: Uri =
		DocumentsContract.buildDocumentUri("com.android.externalstorage.documents", "primary:$DEFAULT_FOLDER")

	fun setFolder(uri: Uri) {
		// Only the chosen folder stays readable.
		folder?.takeIf { it != uri }?.let { old ->
			runCatching { context.contentResolver.releasePersistableUriPermission(old, Intent.FLAG_GRANT_READ_URI_PERMISSION) }
		}
		runCatching {
			context.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
		}.onFailure { Log.w(TAG, "Cannot keep access to the fonts folder: ${it.javaClass.simpleName}") }
		prefs.fontsFolder = uri.toString()
		access = null
		scanned = false
	}

	/** Whether the app may read the fonts folder. Asks the system at most once until the next [scan]. */
	fun hasAccess(): Boolean = access ?: readAccess(folder).also { access = it }

	private fun readAccess(folder: Uri?): Boolean = folder != null &&
		context.contentResolver.persistedUriPermissions.any { it.uri == folder && it.isReadPermission }

	/**
	 * Recalls the families from the last listing without asking the folder, so opening a book
	 * never waits on it. Returns false when there is nothing to recall; [scan] then has to run.
	 */
	fun restore(): Boolean {
		if (scanned || restored) return true
		val cached = prefs.fontsCache?.let(::parseCache) ?: return false
		setFaces(cached)
		restored = true
		return true
	}

	/** Lists the folder once per process. */
	suspend fun ensureScanned(): List<FontChoice> = if (scanned) families else scan()

	/** Whether this process has listed the folder; until then the families may be out of date. */
	val isScanned: Boolean get() = scanned

	/** Lists the fonts in the folder. Cheap: one directory listing, no font files are read. */
	suspend fun scan(): List<FontChoice> {
		val found = withContext(Dispatchers.IO) {
			val folder = folder
			val granted = readAccess(folder).also { access = it }
			if (folder == null || !granted) emptyList() else list(folder)
		}
		setFaces(found)
		val cache = toCache(found)
		if (cache != prefs.fontsCache) prefs.fontsCache = cache
		scanned = true
		return families
	}

	private fun setFaces(faces: List<FontFace>) {
		val old = files
		val current = faces.associateBy { it.fileName }
		files = current
		families = group(faces)
		// Keep what was read of fonts that are still there, unchanged.
		old.forEach { (name, face) ->
			val now = current[name]
			if (now == null || now.uri != face.uri || now.size != face.size) bytes.remove(name)
		}
	}

	fun family(name: String?): FontChoice? = name?.let { families.firstOrNull { family -> family.family == name } }

	/** Declares every known family to the navigator, so switching between them needs no reload. */
	@OptIn(ExperimentalReadiumApi::class)
	fun declare(configuration: EpubNavigatorFragment.Configuration, choices: List<FontChoice>) {
		choices.forEach { choice ->
			configuration.addFontFamilyDeclaration(FontFamily(choice.family)) {
				choice.faces.forEach { face ->
					addFontFace {
						addSource(href(face))
						setFontWeight(face.weight)
						setFontStyle(if (face.italic) FontStyle.ITALIC else FontStyle.NORMAL)
					}
				}
			}
		}
	}

	/** Serves the font files alongside the publication's own resources. */
	fun wrap(container: Container<Resource>): Container<Resource> = object : Container<Resource> {
		override val sourceUrl: AbsoluteUrl? get() = container.sourceUrl
		override val entries: Set<Url> get() = container.entries
		override fun get(url: Url): Resource? = resource(url) ?: container[url]
		override fun close() = container.close()
	}

	/** Called by the web views' request threads. Serves only files from the last listing. */
	private fun resource(url: Url): Resource? {
		val path = url.toString()
		if (!path.startsWith(FONTS_URL)) return null
		val name = Uri.decode(path.substring(FONTS_URL.length))
		val face = files[name] ?: return null
		bytes.get(name)?.let { return InMemoryResource(it) }
		val size = face.size
		if (size == null || size > MAX_CACHED_FONT_BYTES) return ContentResource(face.uri, context.contentResolver)
		return InMemoryResource(sourceUrl = null, properties = Resource.Properties()) {
			ContentResource(face.uri, context.contentResolver).use { it.read() }.onSuccess { bytes.put(name, it) }
		}
	}

	private fun href(face: FontFace): Url = Url("$FONTS_URL${Uri.encode(face.fileName)}")!!

	private fun list(folder: Uri): List<FontFace> {
		val result = mutableListOf<FontFace>()
		try {
			val children = DocumentsContract.buildChildDocumentsUriUsingTree(
				folder,
				DocumentsContract.getTreeDocumentId(folder),
			)
			val columns = arrayOf(
				DocumentsContract.Document.COLUMN_DOCUMENT_ID,
				DocumentsContract.Document.COLUMN_DISPLAY_NAME,
				DocumentsContract.Document.COLUMN_SIZE,
			)
			context.contentResolver.query(children, columns, null, null, null)?.use { cursor ->
				while (cursor.moveToNext()) {
					val name = cursor.getString(1) ?: continue
					if (name.substringAfterLast('.', "").lowercase() !in EXTENSIONS) continue
					val uri = DocumentsContract.buildDocumentUriUsingTree(folder, cursor.getString(0))
					val size = if (cursor.isNull(2)) null else cursor.getLong(2)
					face(name, uri, size)?.let { result += it }
				}
			}
		} catch (error: Exception) {
			Log.w(TAG, "Cannot list the fonts folder: ${error.javaClass.simpleName}")
		}
		return result
	}

	private fun toCache(faces: List<FontFace>): String = JSONArray().apply {
		faces.forEach { face ->
			put(JSONObject().put("name", face.fileName).put("uri", face.uri.toString()).put("size", face.size ?: -1L))
		}
	}.toString()

	private fun parseCache(json: String): List<FontFace>? = try {
		val array = JSONArray(json)
		(0 until array.length()).mapNotNull { index ->
			val item = array.getJSONObject(index)
			face(item.getString("name"), Uri.parse(item.getString("uri")), item.optLong("size", -1L).takeIf { it >= 0 })
		}
	} catch (error: Exception) {
		null
	}

	private companion object {
		const val TAG = "Squidread"
		const val DEFAULT_FOLDER = "fonts"

		/** The navigator serves the publication from this origin; fonts must share it. */
		const val FONTS_URL = "https://readium_package/squidread-fonts/"

		const val MAX_CACHED_BYTES = 8 * 1024 * 1024
		const val MAX_CACHED_FONT_BYTES = 2L * 1024 * 1024

		val EXTENSIONS = setOf("ttf", "otf", "woff", "woff2")

		val WEIGHTS = mapOf(
			"thin" to FontWeight.THIN,
			"hairline" to FontWeight.THIN,
			"extralight" to FontWeight.EXTRA_LIGHT,
			"ultralight" to FontWeight.EXTRA_LIGHT,
			"light" to FontWeight.LIGHT,
			"regular" to FontWeight.NORMAL,
			"normal" to FontWeight.NORMAL,
			"book" to FontWeight.NORMAL,
			"medium" to FontWeight.MEDIUM,
			"semibold" to FontWeight.SEMI_BOLD,
			"demibold" to FontWeight.SEMI_BOLD,
			"bold" to FontWeight.BOLD,
			"extrabold" to FontWeight.EXTRA_BOLD,
			"ultrabold" to FontWeight.EXTRA_BOLD,
			"black" to FontWeight.BLACK,
			"heavy" to FontWeight.BLACK,
		)

		/** `Family-BoldItalic`, `Family_Light`, `Family Bold Italic`; anything else is a regular face. */
		val STYLED_NAME = Regex(
			"^(.+?)[-_ ](${WEIGHTS.keys.sortedByDescending { it.length }.joinToString("|")})?(?:[-_ ]?(italic|oblique))?$",
			RegexOption.IGNORE_CASE,
		)

		/** A capital after a small letter, as in `NotoSerif`. */
		val WORD_START = Regex("(?<=\\p{Ll})(?=\\p{Lu})")

		fun face(fileName: String, uri: Uri, size: Long?): FontFace? {
			val base = fileName.substringBeforeLast('.')
			val match = STYLED_NAME.matchEntire(base)?.groupValues
			val weight = match?.get(2).orEmpty().lowercase()
			val italic = match?.get(3).orEmpty().isNotEmpty()
			val styled = weight.isNotEmpty() || italic
			// The name goes into CSS; keep it to characters that need no escaping. Names written
			// together, like `NotoSerif`, are spaced as they're spoken: "Noto Serif".
			val family = (if (styled) match!![1] else base)
				.replace('_', ' ')
				.replace(WORD_START, " ")
				.filter { it.isLetterOrDigit() || it == ' ' || it == '-' }
				.trim()
				.ifEmpty { return null }
			return FontFace(family, fileName, uri, WEIGHTS[weight] ?: FontWeight.NORMAL, italic, size)
		}

		fun group(faces: List<FontFace>): List<FontChoice> = faces
			.groupBy { it.family }
			.map { (family, members) -> FontChoice(family, members.distinctBy { it.weight to it.italic }) }
			.sortedBy { it.family.lowercase() }
	}
}
