package com.omrilotan.squidread

/**
 * Keeps the reader on the same words when a text setting reflows the chapter.
 *
 * Readium keeps the page number within the chapter instead, so a bigger font size shows text
 * from before the page the reader was on. [KEEP_PLACE_SCRIPT] remembers the first character on
 * the page before the change; [RESTORE_PLACE_SCRIPT] then waits for the new layout to settle,
 * after Readium's own adjustment, and turns to the page that character is now on. The same
 * character is kept for further changes until the page is turned.
 */

/** Returns true when a place was remembered, or kept from an earlier change on this page. */
const val KEEP_PLACE_SCRIPT = """
(function () {
	if (!window.readium || !window.readium.isReflowable) return false;
	// Kept while the page stays where it was put, so repeated changes don't drift.
	var kept = window.squidreadPlace;
	if (kept && (kept.at === undefined || Math.abs(kept.at - document.scrollingElement.scrollLeft) < 1)) return true;
	if (getComputedStyle(document.documentElement).writingMode.indexOf('vertical') === 0) return false;
	var width = window.innerWidth;
	var rtl = document.body.dir.toLowerCase() === 'rtl';
	// On an earlier page: to the left, or to the right in a right-to-left book.
	function earlier(rect) { return rtl ? rect.left >= width : rect.right <= 0; }
	// The first character from index on that is laid out; collapsed spaces have no box.
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
	var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
	for (var node = walker.nextNode(); node; node = walker.nextNode()) {
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
		var at = charRect(node, low, last);
		window.squidreadPlace = { node: node, offset: low, rect: at, turn: 0 };
		return true;
	}
	return false;
})();
"""

/** Runs after the setting is applied. A later change takes over a restore still waiting. */
const val RESTORE_PLACE_SCRIPT = """
(function () {
	var place = window.squidreadPlace;
	if (!place) return;
	var turn = ++place.turn;
	place.at = undefined;
	var range = document.createRange();
	function rect() {
		if (!place.node.isConnected) return null;
		range.setStart(place.node, place.offset);
		range.setEnd(place.node, Math.min(place.offset + 1, place.node.length));
		return range.getClientRects()[0] || null;
	}
	function same(a, b) { return a === b || (a && b && a.left === b.left && a.top === b.top); }
	// Compared with where the character was before the change, which may be in place already.
	var start = place.rect, previous = rect(), moved = false, still = 0, frames = 0;
	function step() {
		if (place.turn !== turn) return;
		var now = rect();
		if (!same(now, start)) moved = true;
		still = same(now, previous) ? still + 1 : 0;
		previous = now;
		// Settled: moved, then unchanged for a few frames, which covers Readium's own snap.
		if (!(moved && still >= 3) && ++frames < 90) return requestAnimationFrame(step);
		if (!now) { window.squidreadPlace = null; return; }
		// Readium's page width, which may be a fraction of a pixel narrower than innerWidth.
		var width = window.Android && Android.getViewportWidth ? Android.getViewportWidth() / window.devicePixelRatio : window.innerWidth;
		var x = now.left + now.width / 2 + window.scrollX;
		document.scrollingElement.scrollLeft = Math.floor(x / width) * width;
		place.at = document.scrollingElement.scrollLeft;
		place.rect = rect();
	}
	requestAnimationFrame(step);
})();
"""
