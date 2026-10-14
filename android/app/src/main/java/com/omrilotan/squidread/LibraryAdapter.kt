package com.omrilotan.squidread

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

/** "Add EPUB" tile followed by the books, most recently opened first. */
class LibraryAdapter(
	private val library: Library,
	private val covers: CoverCache,
	private val scope: CoroutineScope,
	private val onAdd: () -> Unit,
	private val onOpen: (Book) -> Unit,
	private val onDelete: (Book) -> Unit,
) : RecyclerView.Adapter<RecyclerView.ViewHolder>() {
	private var books: List<Book> = emptyList()
	private var currentId: String? = null

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

	override fun getItemCount() = books.size + 1

	override fun getItemViewType(position: Int) = if (position == 0) TYPE_ADD else TYPE_BOOK

	override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RecyclerView.ViewHolder {
		val inflater = LayoutInflater.from(parent.context)
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
	}
}
