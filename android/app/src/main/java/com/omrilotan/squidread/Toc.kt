package com.omrilotan.squidread

import android.annotation.SuppressLint
import android.graphics.Typeface
import android.view.View
import android.widget.ImageView
import androidx.core.content.ContextCompat
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.text.HtmlCompat
import androidx.recyclerview.widget.RecyclerView
import org.readium.r2.shared.publication.Link
import org.readium.r2.shared.publication.Locator
import org.readium.r2.shared.util.Url

class TocEntry(
	val link: Link,
	val title: String,
	val depth: Int,
	/** Hierarchical chapter number, e.g. "2.3", as shown in the footer. */
	val number: String,
	/** Resource path without fragment, for matching the current location. */
	val path: String,
	/** Position in the list. */
	val index: Int,
)

/** Builds the contents list. Cheap enough for the background thread that opens the book. */

fun buildToc(links: List<Link>): List<TocEntry> {
	val entries = mutableListOf<TocEntry>()
	fun visit(items: List<Link>, depth: Int, parentNumber: String) {
		// Deeper levels than any real book has are left out rather than recursed into.
		if (depth > MAX_DEPTH) return
		items.forEachIndexed { index, link ->
			val number = if (parentNumber.isEmpty()) "${index + 1}" else "$parentNumber.${index + 1}"
			entries += TocEntry(
				link = link,
				title = Library.cleanTitle(link.title) ?: Library.cleanTitle(link.href.toString()).orEmpty(),
				depth = depth,
				number = number,
				path = link.url().pathWithoutFragment(),
				index = entries.size,
			)
			visit(link.children, depth + 1, number)
		}
	}
	visit(links, 0, "")
	return entries
}

/**
 * Stands in for a missing table of contents: one entry per file of the reading order, in order.
 * Titles come from the book where it names its files, and from [label] where it doesn't.
 */
fun buildSections(readingOrder: List<Link>, label: (number: Int) -> String): List<TocEntry> =
	readingOrder.mapIndexed { index, link ->
		TocEntry(
			link = link,
			title = Library.cleanTitle(link.title) ?: label(index + 1),
			depth = 0,
			number = "${index + 1}",
			path = link.url().pathWithoutFragment(),
			index = index,
		)
	}

/** The same entries, with the titles found in the files themselves where there are any. */
fun List<TocEntry>.withTitles(titles: List<String?>): List<TocEntry> =
	mapIndexed { index, entry ->
		titles.getOrNull(index)?.let { title ->
			TocEntry(entry.link, title, entry.depth, entry.number, entry.path, entry.index)
		} ?: entry
	}

/**
 * The text of the first heading in a file's opening bytes, if it has one. A rough reading that
 * needs no parser: headings are short and come early.
 */
fun firstHeading(html: String): String? {
	val match = HEADING.find(html) ?: return null
	val text = HtmlCompat.fromHtml(match.groupValues[1], HtmlCompat.FROM_HTML_MODE_LEGACY).toString()
	// Images in a heading come through as object placeholders.
	return Library.cleanTitle(text.replace('\uFFFC', ' ').replace(WHITESPACE, " ").trim())
}

private val HEADING = Regex("<h[1-6][^>]{0,500}>(.{0,1000}?)</h[1-6]\\s*>", setOf(RegexOption.IGNORE_CASE, RegexOption.DOT_MATCHES_ALL))
private val WHITESPACE = Regex("\\s+")

private const val MAX_DEPTH = 32

/** Deeper entries keep this indent, so they never squeeze to nothing. */
private const val MAX_INDENT_DEPTH = 6
private const val INDENT_DP = 20

/** Lists longer than this fold; shorter ones show every entry. */
private const val FOLD_THRESHOLD = 60

private fun Url.pathWithoutFragment() = removeFragment().toString()

/**
 * The contents list. A long list folds each entry's sections under it, except along the way to
 * the page showing; a short one shows everything, with no taps in between.
 */
class TocAdapter(private val onSelect: (TocEntry) -> Unit) : RecyclerView.Adapter<TocAdapter.Holder>() {
	private var entries: List<TocEntry> = emptyList()
	private var lastPath: String? = null
	private var lastMatch: TocEntry? = null

	/** The entries showing, by their place in [entries]. */
	private var shown: List<Int> = emptyList()

	/** Entries whose sections are hidden, by their place in [entries]. */
	private val folded = HashSet<Int>()
	private var foldable = false

	/** Whether the book has sections under its chapters, which then show in bold. */
	private var nested = false

	var activeIndex = -1
		private set

	/** Where the active entry is in the list as shown; -1 when it isn't showing. */
	val activePosition get() = shown.indexOf(activeIndex)

	var topLevelCount = 0
		private set

	// A new book replaces every entry; there's nothing finer to report.
	@SuppressLint("NotifyDataSetChanged")
	fun submit(items: List<TocEntry>) {
		entries = items
		topLevelCount = items.count { it.depth == 0 }
		nested = items.any { it.depth > 0 }
		foldable = items.size > FOLD_THRESHOLD
		folded.clear()
		if (foldable) items.forEach { if (hasSections(it.index)) folded += it.index }
		val active = activeIndex
		activeIndex = -1
		lastPath = null
		lastMatch = null
		// Titles found later replace the entries of the same book; its place stays open.
		if (active in items.indices) {
			activeIndex = active
			unfoldTo(active)
		}
		refresh()
	}

	/** First entry pointing at the locator's resource, like the web app. */
	fun entryFor(locator: Locator): TocEntry? {
		val path = locator.href.pathWithoutFragment()
		if (path != lastPath) {
			lastPath = path
			lastMatch = entries.firstOrNull { it.path == path }
		}
		return lastMatch
	}

	fun setActive(entry: TocEntry?) {
		val index = entry?.index ?: -1
		if (index == activeIndex) return
		val previous = shown.indexOf(activeIndex)
		activeIndex = index
		if (index >= 0 && unfoldTo(index)) {
			refresh()
			return
		}
		if (previous >= 0) notifyItemChanged(previous)
		shown.indexOf(index).takeIf { it >= 0 }?.let { notifyItemChanged(it) }
	}

	private fun hasSections(index: Int): Boolean {
		val next = entries.getOrNull(index + 1) ?: return false
		return next.depth > entries[index].depth
	}

	/** Shows the entry, and its own sections; true if anything was folded. */
	private fun unfoldTo(index: Int): Boolean {
		var changed = folded.remove(index)
		var depth = entries[index].depth
		for (each in index - 1 downTo 0) {
			if (depth == 0) break
			if (entries[each].depth < depth) {
				changed = folded.remove(each) || changed
				depth = entries[each].depth
			}
		}
		return changed
	}

	private fun toggle(index: Int) {
		if (!folded.remove(index)) folded += index
		refresh()
	}

	// Folding moves every row after it.
	@SuppressLint("NotifyDataSetChanged")
	private fun refresh() {
		val list = ArrayList<Int>(entries.size)
		// Entries deeper than this are inside a folded entry.
		var hiddenBelow = Int.MAX_VALUE
		for (entry in entries) {
			if (entry.depth > hiddenBelow) continue
			hiddenBelow = if (entry.index in folded) entry.depth else Int.MAX_VALUE
			list += entry.index
		}
		shown = list
		notifyDataSetChanged()
	}

	override fun getItemCount() = shown.size

	override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
		Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_toc, parent, false))

	override fun onBindViewHolder(holder: Holder, position: Int) {
		val entry = entries[shown[position]]
		val resources = holder.itemView.resources
		val density = resources.displayMetrics.density
		val selected = entry.index == activeIndex
		holder.title.text = entry.title
		holder.title.setTypeface(null, if (nested && entry.depth == 0) Typeface.BOLD else Typeface.NORMAL)
		holder.itemView.isSelected = selected
		// Sections sit in from their chapter, line and all.
		(holder.itemView.layoutParams as ViewGroup.MarginLayoutParams).marginStart =
			(minOf(entry.depth, MAX_INDENT_DEPTH) * INDENT_DP * density).toInt()
		holder.itemView.setOnClickListener { onSelect(entry) }

		val canFold = foldable && hasSections(entry.index)
		holder.fold.visibility = if (canFold) View.VISIBLE else View.GONE
		if (canFold) {
			val isFolded = entry.index in folded
			holder.fold.isSelected = selected
			holder.fold.setImageResource(if (isFolded) R.drawable.ic_fold_closed else R.drawable.ic_fold_open)
			holder.fold.contentDescription = resources.getString(if (isFolded) R.string.toc_unfold else R.string.toc_fold)
			holder.fold.setOnClickListener { toggle(entry.index) }
		}
	}

	class Holder(view: View) : RecyclerView.ViewHolder(view) {
		val title: TextView = view.findViewById(R.id.toc_title)
		val fold: ImageView = view.findViewById<ImageView>(R.id.toc_fold).apply {
			imageTintList = ContextCompat.getColorStateList(view.context, R.color.button_text)
		}
	}
}
