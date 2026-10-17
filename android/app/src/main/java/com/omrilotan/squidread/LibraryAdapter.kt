package com.omrilotan.squidread

import android.annotation.SuppressLint
import android.graphics.Typeface
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch

/**
 * "Add EPUB" tile followed by the books, most recently opened first. While there are no books,
 * [emptyHint] follows the tile, across the whole row.
 */
class LibraryAdapter(
	private val library: Library,
	private val covers: CoverCache,
	private val scope: CoroutineScope,
	private val onAdd: () -> Unit,
	private val onOpen: (Book) -> Unit,
	private val onDelete: (Book) -> Unit,
	private val emptyHint: CharSequence,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
	private var books: List<Book> = emptyList()
	private var currentId: String? = null

	// The order follows the last opened book and the open book's title is marked, so most tiles
	// can move or change. With item animations off, one full rebind is a single redraw, which is
	// what e-ink wants; working out the smallest change would cost more than it saves.
	@SuppressLint("NotifyDataSetChanged")
	fun refresh(current: String?) {
		books = library.all()
		currentId = current
		notifyDataSetChanged()
	}

	/**
	 * Decodes the covers of the first [count] books ahead of time, so the library draws with its
	 * covers in place rather than filling them in one refresh at a time.
	 */
	suspend fun preload(count: Int) = coroutineScope {
		library.all().take(count).map { book -> async { covers.load(book.id, library.coverFile(book.id)) } }.awaitAll()
		Unit
	}

	override fun getItemCount() = if (books.isEmpty()) 2 else books.size + 1

	override fun getItemViewType(position: Int) = when {
		position == 0 -> TYPE_ADD
		books.isEmpty() -> TYPE_HINT
		else -> TYPE_BOOK
	}

	/** Whether the item at [position] takes a whole row of the grid. */
	fun isFullRow(position: Int) = getItemViewType(position) == TYPE_HINT

	override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
		val inflater = LayoutInflater.from(parent.context)
		if (viewType == TYPE_HINT) {
			val hint = inflater.inflate(R.layout.item_library_hint, parent, false) as TextView
			hint.text = emptyHint
			return object : RecyclerView.ViewHolder(hint) {}
		}
		val view = inflater.inflate(R.layout.item_library, parent, false)
		return if (viewType == TYPE_ADD) AddHolder(view) else BookHolder(view)
	}

	override fun onBindViewHolder(holder: RecyclerView.ViewHolder, position: Int) {
		when (holder) {
			is AddHolder -> holder.bind()
			is BookHolder -> holder.bind(books[position - 1])
		}
	}

	private inner class AddHolder(view: View) : RecyclerView.ViewHolder(view) {
		fun bind() {
			itemView.findViewById<TextView>(R.id.title).setText(R.string.add_epub)
			itemView.findViewById<View>(R.id.delete).isVisible = false
			itemView.findViewById<CoverView>(R.id.cover).setImageDrawable(null)
			itemView.findViewById<View>(R.id.book).setOnClickListener { onAdd() }
		}
	}

	private inner class BookHolder(view: View) : RecyclerView.ViewHolder(view) {
		private val cover = view.findViewById<CoverView>(R.id.cover)
		private val title = view.findViewById<TextView>(R.id.title)
		private val frame = view.findViewById<View>(R.id.book)
		private val delete = view.findViewById<View>(R.id.delete)
		private var coverJob: Job? = null

		fun bind(book: Book) {
			title.text = book.title
			// The open book is marked with a heavier title rather than a grey tint.
			title.setTypeface(null, if (book.id == currentId) Typeface.BOLD else Typeface.NORMAL)
			frame.setOnClickListener { onOpen(book) }
			delete.isVisible = true
			delete.setOnClickListener { onDelete(book) }

			// A recycled tile stops decoding the cover of the book it showed before.
			coverJob?.cancel()
			val cached = covers.cached(book.id)
			cover.setImageBitmap(cached)
			if (cached == null) {
				coverJob = scope.launch {
					covers.load(book.id, library.coverFile(book.id))?.let(cover::setImageBitmap)
				}
			}
		}
	}

	private companion object {
		const val TYPE_ADD = 0
		const val TYPE_BOOK = 1
		const val TYPE_HINT = 2
	}
}
