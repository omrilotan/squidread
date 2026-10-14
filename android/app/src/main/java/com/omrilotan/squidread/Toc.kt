package com.omrilotan.squidread

import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.TextView
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

private const val MAX_DEPTH = 32

/** Deeper entries keep this indent, so they never squeeze to nothing. */
private const val MAX_INDENT_DEPTH = 6

private fun Url.pathWithoutFragment() = removeFragment().toString()

class TocAdapter(private val onSelect: (TocEntry) -> Unit) : RecyclerView.Adapter<TocAdapter.Holder>() {
	private var entries: List<TocEntry> = emptyList()
	private var lastPath: String? = null
	private var lastMatch: TocEntry? = null

	var activeIndex = -1
		private set

	var topLevelCount = 0
		private set

	fun submit(items: List<TocEntry>) {
		entries = items
		topLevelCount = items.count { it.depth == 0 }
		activeIndex = -1
		lastPath = null
		lastMatch = null
		notifyDataSetChanged()
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
		val previous = activeIndex
		activeIndex = index
		if (previous >= 0) notifyItemChanged(previous)
		if (index >= 0) notifyItemChanged(index)
	}

	override fun getItemCount() = entries.size

	override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
		Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_toc, parent, false) as TextView)

	override fun onBindViewHolder(holder: Holder, position: Int) {
		val entry = entries[position]
		val density = holder.view.resources.displayMetrics.density
		holder.view.text = entry.title
		holder.view.isSelected = position == activeIndex
		holder.view.setPaddingRelative(
			((16 + minOf(entry.depth, MAX_INDENT_DEPTH) * 20) * density).toInt(),
			holder.view.paddingTop,
			holder.view.paddingEnd,
			holder.view.paddingBottom,
		)
		holder.view.setOnClickListener { onSelect(entry) }
	}

	class Holder(val view: TextView) : RecyclerView.ViewHolder(view)
}
