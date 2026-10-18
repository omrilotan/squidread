package com.omrilotan.squidread

import java.io.File
import java.io.IOException
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

/** Uncompressed bytes a rewrite may write, so an archive built to expand without end can't fill the device. */
private const val MAX_REPAIR_BYTES = 1L shl 30
private const val BUFFER_SIZE = 64 * 1024

/**
 * Rewrites [file] without repeated entries, keeping the first of each name. Android's zip reader
 * refuses an archive that lists a file twice, but some EPUB makers write one (a cover image that
 * is also a page). Returns whether the file was rewritten; an archive with no repeats, or one
 * that can't be read in order, is left as it is. Blocks, so call off the main thread.
 */
fun dropDuplicateEntries(file: File): Boolean {
	val temp = File(file.parentFile, "${file.name}.${System.nanoTime()}.tmp")
	try {
		val names = HashSet<String>()
		var dropped = false
		var total = 0L
		ZipInputStream(file.inputStream().buffered()).use { input ->
			ZipOutputStream(temp.outputStream().buffered()).use { output ->
				val buffer = ByteArray(BUFFER_SIZE)
				while (true) {
					val entry = input.nextEntry ?: break
					if (!names.add(entry.name)) {
						dropped = true
						continue
					}
					output.putNextEntry(ZipEntry(entry.name))
					while (true) {
						val count = input.read(buffer)
						if (count < 0) break
						total += count
						if (total > MAX_REPAIR_BYTES) throw IOException("Too large")
						output.write(buffer, 0, count)
					}
					output.closeEntry()
				}
			}
		}
		// Renaming within one folder replaces the book in a single step.
		return dropped && temp.renameTo(file)
	} catch (error: Exception) {
		// Also malformed names (IllegalArgumentException) and paths Android refuses to unpack.
		return false
	} finally {
		temp.delete()
	}
}
