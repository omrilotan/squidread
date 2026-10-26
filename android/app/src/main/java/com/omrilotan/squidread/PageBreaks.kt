package com.omrilotan.squidread

import android.content.Context
import android.util.AttributeSet
import android.view.LayoutInflater
import android.view.View
import android.webkit.WebView
import androidx.appcompat.app.AppCompatDelegate
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * Builds the screen's views as AppCompat does, except for the web views Readium shows the book
 * in, which get [PAGE_BREAKS_SCRIPT] before their first page loads. Readium loads that page as
 * soon as it creates the view, before anything else can reach it.
 */
class BookViewFactory(private val delegate: AppCompatDelegate) : LayoutInflater.Factory2 {
	override fun onCreateView(parent: View?, name: String, context: Context, attrs: AttributeSet): View? {
		if (name == READIUM_WEB_VIEW) {
			// Readium keeps the class to itself; its layout names it, so it is never renamed.
			val view = Class.forName(name).getConstructor(Context::class.java, AttributeSet::class.java).newInstance(context, attrs)
			return (view as WebView).also(::keepPageBreaks)
		}
		return delegate.createView(parent, name, context, attrs)
	}

	override fun onCreateView(name: String, context: Context, attrs: AttributeSet): View? =
		onCreateView(null, name, context, attrs)
}

private const val READIUM_WEB_VIEW = "org.readium.r2.navigator.R2WebView"

/** Web views too old to run a script at the start of each page lay out page breaks as before. */
private fun keepPageBreaks(view: WebView) {
	if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return
	WebViewCompat.addDocumentStartJavaScript(view, PAGE_BREAKS_SCRIPT, setOf(BOOK_ORIGIN))
}

/** Where Readium serves the book's own pages. */
private const val BOOK_ORIGIN = "https://readium_package"

/**
 * Books ask for a new page before chapters and pictures with page breaks, but Readium lays the
 * book out in columns, where a page break means nothing. They are made column breaks, which
 * start a new page there, once the book's styles have loaded and before Readium lays it out.
 */
private const val PAGE_BREAKS_SCRIPT = """
(function () {
	var PAGE = { page: 1, left: 1, right: 1, recto: 1, verso: 1 };
	function fix(style) {
		if (PAGE[style.breakBefore]) style.breakBefore = 'column';
		if (PAGE[style.breakAfter]) style.breakAfter = 'column';
	}
	function walk(rules) {
		for (var i = 0; i < rules.length; i++) {
			if (rules[i].style) fix(rules[i].style);
			if (rules[i].cssRules) walk(rules[i].cssRules);
		}
	}
	function apply() {
		for (var i = 0; i < document.styleSheets.length; i++) {
			// Style sheets from elsewhere can't be read; books keep theirs inside.
			try { walk(document.styleSheets[i].cssRules); } catch (error) {}
		}
		var styled = document.querySelectorAll('[style]');
		for (var j = 0; j < styled.length; j++) fix(styled[j].style);
	}
	// Again once every style sheet has loaded.
	document.addEventListener('DOMContentLoaded', apply);
	window.addEventListener('load', apply);
})();
"""
