package com.omrilotan.squidread

import android.annotation.SuppressLint
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.recyclerview.widget.RecyclerView
import org.json.JSONArray
import org.json.JSONObject
import org.readium.r2.shared.publication.Locator

/**
 * Bookmarks keep the first whole word on the page, with some of the text on either side, so a
 * bookmark finds its words again after a font or size change has moved them to another page.
 *
 * The scripts read a chapter's text as one string: every text node of the body, in order. Words
 * are found in that string, and turned back into a range on the page to see where they are.
 */
private const val TEXT_FUNCTIONS = """
function squidreadText() {
	var nodes = [], starts = [], full = '';
	var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (var node = walker.nextNode(); node; node = walker.nextNode()) {
		nodes.push(node);
		starts.push(full.length);
		full += node.data;
	}
	// The node and offset of a character of the string.
	function at(offset) {
		var low = 0, high = nodes.length - 1;
		while (low < high) {
			var middle = (low + high + 1) >> 1;
			if (starts[middle] <= offset) low = middle; else high = middle - 1;
		}
		return { node: nodes[low], offset: Math.min(offset - starts[low], nodes[low].length) };
	}
	return { nodes: nodes, starts: starts, full: full, at: at };
}
// The words of a bookmark as a range, found with as much of the text around them as still matches.
function squidreadFind(text, quote) {
	var before = quote.before || '', word = quote.highlight || '', after = quote.after || '';
	if (!word || !text.nodes.length) return null;
	var tries = [[before, after], ['', after], [before, ''], ['', '']];
	for (var i = 0; i < tries.length; i++) {
		var found = text.full.indexOf(tries[i][0] + word + tries[i][1]);
		if (found < 0) continue;
		var start = text.at(found + tries[i][0].length), end = text.at(found + tries[i][0].length + word.length);
		var range = document.createRange();
		range.setStart(start.node, start.offset);
		range.setEnd(end.node, end.offset);
		return range;
	}
	return null;
}
"""

/**
 * The first whole word on the page showing, with the text before and after it; nothing
 * when the page has no words, or the book isn't laid out in pages.
 */
const val PAGE_WORD_SCRIPT = """
(function () {
	$TEXT_FUNCTIONS
	if (!window.readium || !window.readium.isReflowable) return null;
	if (getComputedStyle(document.documentElement).writingMode.indexOf('vertical') === 0) return null;
	var width = window.innerWidth;
	var rtl = document.body.dir.toLowerCase() === 'rtl';
	function earlier(rect) { return rtl ? rect.left >= width : rect.right <= 0; }
	function later(rect) { return rtl ? rect.right <= 0 : rect.left >= width; }
	function charRect(node, index, last) {
		var range = document.createRange();
		for (var i = index; i <= last; i++) {
			range.setStart(node, i);
			range.setEnd(node, i + 1);
			var rects = range.getClientRects();
			if (rects.length) return rects[0];
		}
		return null;
	}
	var text = squidreadText();
	var offset = -1;
	for (var n = 0; n < text.nodes.length; n++) {
		var node = text.nodes[n];
		var last = node.data.search(/\s*$/) - 1;
		if (last < 0) continue;
		var end = charRect(node, last, last) || charRect(node, 0, last);
		if (!end || earlier(end)) continue;
		var low = 0, high = last;
		while (low < high) {
			var middle = (low + high) >> 1;
			var rect = charRect(node, middle, last);
			if (rect && !earlier(rect)) high = middle; else low = middle + 1;
		}
		var first = charRect(node, low, last);
		if (first && later(first)) return null;
		offset = text.starts[n] + low;
		break;
	}
	if (offset < 0) return null;
	var full = text.full, letter = /[\p{L}\p{M}\p{N}]/u;
	// A word broken across pages belongs to the page before; take the next one.
	if (offset > 0 && letter.test(full[offset - 1])) while (offset < full.length && letter.test(full[offset])) offset++;
	while (offset < full.length && !letter.test(full[offset])) offset++;
	var stop = offset;
	while (stop < full.length && letter.test(full[stop])) stop++;
	if (stop === offset) return null;
	return {
		before: full.slice(Math.max(0, offset - 40), offset),
		highlight: full.slice(offset, stop),
		after: full.slice(stop, stop + 100),
	};
})();
"""

private fun quoteJson(text: Locator.Text) = JSONObject()
	.put("before", text.before.orEmpty())
	.put("highlight", text.highlight.orEmpty())
	.put("after", text.after.orEmpty())

/** Which of [quotes] is on the page showing: its place in the list, or -1. */
fun pageBookmarkScript(quotes: List<Locator.Text>) = """
(function () {
	$TEXT_FUNCTIONS
	var quotes = ${JSONArray(quotes.map(::quoteJson))};
	var text = squidreadText();
	for (var i = 0; i < quotes.length; i++) {
		var range = squidreadFind(text, quotes[i]);
		var rect = range && range.getClientRects()[0];
		if (!rect) continue;
		var middle = rect.left + rect.width / 2;
		if (middle >= 0 && middle < window.innerWidth) return i;
	}
	return -1;
})();
"""

/** Turns to the page with the bookmark's words, as [revealScript] does. */
fun revealBookmarkScript(quote: Locator.Text) =
	revealScript("(function () { $TEXT_FUNCTIONS return squidreadFind(squidreadText(), ${quoteJson(quote)}); })()")

/** A bookmark as listed: its chapter, and the text from its first word. */
class BookmarkRow(val chapter: String?, val text: String?)

/** The bookmarks, listed in place of the contents when chosen. */
class BookmarkAdapter(
	private val onSelect: (Int) -> Unit,
	private val onRemove: (Int) -> Unit,
) : RecyclerView.Adapter<BookmarkAdapter.Holder>() {
	private var rows: List<BookmarkRow> = emptyList()

	// The list is small, and changes all at once.
	@SuppressLint("NotifyDataSetChanged")
	fun submit(items: List<BookmarkRow>) {
		rows = items
		notifyDataSetChanged()
	}

	override fun getItemCount() = rows.size

	override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
		Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_bookmark, parent, false))

	override fun onBindViewHolder(holder: Holder, position: Int) {
		val row = rows[position]
		holder.chapter.text = row.chapter
		holder.chapter.visibility = if (row.chapter.isNullOrEmpty()) View.GONE else View.VISIBLE
		holder.text.text = row.text ?: holder.itemView.context.getString(R.string.bookmark_no_text)
		holder.open.setOnClickListener { onSelect(holder.bindingAdapterPosition) }
		holder.remove.setOnClickListener { onRemove(holder.bindingAdapterPosition) }
	}

	class Holder(view: View) : RecyclerView.ViewHolder(view) {
		val open: View = view.findViewById(R.id.bookmark_open)
		val chapter: TextView = view.findViewById(R.id.bookmark_chapter)
		val text: TextView = view.findViewById(R.id.bookmark_text)
		val remove: View = view.findViewById(R.id.bookmark_remove)
	}
}

private val WHITESPACE = Regex("\\s+")

/** The bookmark's words as a line of text, from its first word on. */
fun bookmarkText(locator: Locator): String? {
	val word = locator.text.highlight?.takeIf { it.isNotBlank() } ?: return null
	return (word + locator.text.after.orEmpty()).replace(WHITESPACE, " ").trim() + "…"
}
