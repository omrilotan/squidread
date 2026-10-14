package com.omrilotan.squidread

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CancellationException
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.publication.services.isRestricted
import org.readium.r2.shared.publication.services.positionsByReadingOrder
import org.readium.r2.shared.util.asset.AssetRetriever
import org.readium.r2.shared.util.getOrElse
import org.readium.r2.shared.util.http.DefaultHttpClient
import org.readium.r2.streamer.PublicationOpener
import org.readium.r2.streamer.parser.epub.EpubParser
import java.io.File

/** Readium components shared by the whole app. */
class Readium(context: Context, private val fonts: Fonts) {
	private val httpClient = DefaultHttpClient()
	private val assetRetriever = AssetRetriever(context.contentResolver, httpClient)

	// EPUB only: other formats Readium can open (comics, audiobooks, web publications) would show
	// as dead pages in the EPUB navigator, and each extra parser is more code reading untrusted files.
	private val publicationOpener = PublicationOpener(publicationParser = EpubParser(httpClient))

	/**
	 * Opens an EPUB file, or returns null for anything the reader can't show. Call off the main
	 * thread. A malformed or hostile file never crashes the app: it fails here instead.
	 */
	suspend fun open(file: File): Publication? {
		val asset = assetRetriever.retrieve(file).getOrElse { error ->
			Log.w(TAG, "Cannot read ${file.name}: ${error.message}")
			return null
		}
		val publication = guarded(onFailure = { asset.close() }) {
			publicationOpener.open(
				asset,
				allowUserInteraction = false,
				onCreatePublication = { container = fonts.wrap(container) },
			).getOrElse { error ->
				Log.w(TAG, "Cannot open ${file.name}: ${error.message}")
				asset.close()
				null
			}
		} ?: return null

		return guarded(onFailure = { publication.close() }) {
			// The navigator starts at the first item of the reading order, and crashes without one.
			// It also refuses DRM-protected books (library loans, some stores), which can't be read here.
			val first = publication.readingOrder.firstOrNull()
			if (first == null || publication.isRestricted || publication.locatorFromLink(first) == null) {
				Log.w(TAG, "Nothing to show in ${file.name}")
				publication.close()
				return@guarded null
			}
			// Readium caches positions; computing them here keeps that work off the main thread,
			// where the navigator would otherwise compute them while creating its view.
			publication.positionsByReadingOrder()
			publication
		}
	}

	/**
	 * Runs [block], turning any failure into null: a parser bug, or running out of memory or
	 * stack on a file built to do that (huge declared sizes, deeply nested contents).
	 */
	private inline fun <T> guarded(onFailure: () -> Unit, block: () -> T?): T? = try {
		block()
	} catch (error: CancellationException) {
		onFailure()
		throw error
	} catch (error: Exception) {
		onFailure()
		Log.w(TAG, "Cannot open book: ${error.javaClass.simpleName}")
		null
	} catch (error: VirtualMachineError) {
		onFailure()
		Log.w(TAG, "Cannot open book: ${error.javaClass.simpleName}")
		null
	}

	private companion object {
		const val TAG = "Squidread"
	}
}
