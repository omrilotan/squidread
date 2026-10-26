package com.omrilotan.squidread

import android.annotation.SuppressLint
import android.graphics.Typeface
import android.os.Parcel
import android.os.Parcelable
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.BackgroundColorSpan
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.content.ContextCompat
import androidx.recyclerview.widget.RecyclerView
import org.readium.r2.navigator.Decoration
import org.readium.r2.navigator.html.HtmlDecorationTemplate
import org.readium.r2.navigator.html.HtmlDecorationTemplates
import org.readium.r2.shared.publication.Locator

/** A word or phrase found in the book, with the chapter it is in. */
class SearchResult(val locator: Locator, val chapter: String?)

/**
 * The search match on the page, shown inverted like a selected button: a white box blended by
 * difference turns white paper black and black ink white, in either theme, with no greys.
 */
class SearchMatch : Decoration.Style {
	override fun describeContents() = 0

	override fun writeToParcel(dest: Parcel, flags: Int) = Unit

	override fun equals(other: Any?) = other is SearchMatch

	override fun hashCode() = SearchMatch::class.hashCode()

	companion object {
		@JvmField
		val CREATOR = object : Parcelable.Creator<SearchMatch> {
			override fun createFromParcel(source: Parcel) = SearchMatch()

			override fun newArray(size: Int) = arrayOfNulls<SearchMatch>(size)
		}
	}
}

/** Readium's own decorations, plus [SearchMatch]. */
fun decorationTemplates(): HtmlDecorationTemplates = HtmlDecorationTemplates.defaultTemplates().apply {
	set(
		SearchMatch::class,
		HtmlDecorationTemplate(
			layout = HtmlDecorationTemplate.Layout.BOXES,
			width = HtmlDecorationTemplate.Width.WRAP,
			element = { """<div class="squidread-match"></div>""" },
			// Readium's colour settings clear every background, so the box is filled with a shadow.
			stylesheet = ".squidread-match { box-shadow: inset 0 0 0 100vmax white; mix-blend-mode: difference; }",
		),
	)
}

/**
 * Where the match is on the page, as a fraction of the page's height from the top, or nothing
 * when it isn't on the page showing.
 */
const val MATCH_POSITION_SCRIPT = """
(function () {
	var boxes = document.querySelectorAll('.squidread-match');
	for (var i = 0; i < boxes.length; i++) {
		var rect = boxes[i].getBoundingClientRect();
		if (rect.width > 0 && rect.right > 0 && rect.left < window.innerWidth) return (rect.top + rect.bottom) / 2 / window.innerHeight;
	}
	return null;
})();
"""

/** Turns to the page the match is on, as [revealScript] does. Nothing until the match is drawn. */
val REVEAL_MATCH_SCRIPT = revealScript(
	"Array.prototype.find.call(document.querySelectorAll('.squidread-match'), " +
		"function (each) { return each.getBoundingClientRect().width > 0; })",
)

/** The match with some of the text around it, cut at word breaks, the match inverted. */
fun snippet(locator: Locator, ink: Int, paper: Int): CharSequence {
	val text = locator.text
	val before = text.before.orEmpty().collapse().takeLastWords(SNIPPET_BEFORE)
	val match = text.highlight.orEmpty().collapse()
	val after = text.after.orEmpty().collapse().takeWords(SNIPPET_AFTER)
	val builder = SpannableStringBuilder()
	if (before.isNotEmpty()) builder.append("…").append(before)
	val start = builder.length
	builder.append(match)
	val end = builder.length
	if (after.isNotEmpty()) builder.append(after).append("…")
	if (end > start) {
		builder.setSpan(BackgroundColorSpan(ink), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
		builder.setSpan(ForegroundColorSpan(paper), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
		builder.setSpan(StyleSpan(Typeface.BOLD), start, end, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
	}
	return builder
}

private val WHITESPACE = Regex("\\s+")

private fun String.collapse() = replace(WHITESPACE, " ")

/** The end of the text, from a word break, about [length] characters long. */
private fun String.takeLastWords(length: Int): String {
	if (this.length <= length) return this
	val cut = this.length - length
	val space = indexOf(' ', cut)
	return if (space < 0 || space - cut > length / 2) substring(cut) else substring(space)
}

/** The start of the text, up to a word break, about [length] characters long. */
private fun String.takeWords(length: Int): String {
	if (this.length <= length) return this
	val space = lastIndexOf(' ', length)
	return if (space < length / 2) substring(0, length) else substring(0, space)
}

private const val SNIPPET_BEFORE = 50
private const val SNIPPET_AFTER = 80

class SearchAdapter(private val onSelect: (Int) -> Unit) : RecyclerView.Adapter<SearchAdapter.Holder>() {
	private var results: List<SearchResult> = emptyList()

	// Each search replaces every result; there's nothing finer to report.
	@SuppressLint("NotifyDataSetChanged")
	fun submit(items: List<SearchResult>) {
		results = items
		notifyDataSetChanged()
	}

	override fun getItemCount() = results.size

	override fun onCreateViewHolder(parent: ViewGroup, viewType: Int) =
		Holder(LayoutInflater.from(parent.context).inflate(R.layout.item_search, parent, false))

	override fun onBindViewHolder(holder: Holder, position: Int) {
		val result = results[position]
		val context = holder.itemView.context
		holder.chapter.text = result.chapter
		holder.chapter.visibility = if (result.chapter.isNullOrEmpty()) View.GONE else View.VISIBLE
		holder.text.text = snippet(
			result.locator,
			ink = ContextCompat.getColor(context, R.color.ink),
			paper = ContextCompat.getColor(context, R.color.paper),
		)
		holder.itemView.setOnClickListener { onSelect(holder.bindingAdapterPosition) }
	}

	class Holder(view: View) : RecyclerView.ViewHolder(view) {
		val chapter: TextView = view.findViewById(R.id.search_chapter)
		val text: TextView = view.findViewById(R.id.search_text)
	}
}
