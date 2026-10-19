package com.omrilotan.squidread

import android.app.ActivityManager
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.res.Configuration
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Looper
import android.os.SystemClock
import android.text.format.DateFormat
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import android.widget.GridLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.addCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.annotation.RequiresApi
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.text.HtmlCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsAnimationControlListenerCompat
import androidx.core.view.WindowInsetsAnimationControllerCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.core.view.isVisible
import androidx.core.view.updateLayoutParams
import androidx.core.view.updatePadding
import androidx.fragment.app.Fragment
import androidx.fragment.app.FragmentFactory
import androidx.fragment.app.FragmentManager
import androidx.fragment.app.commitNow
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.lifecycleScope
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import org.readium.r2.navigator.HyperlinkNavigator
import org.readium.r2.navigator.epub.EpubNavigatorFactory
import org.readium.r2.navigator.epub.EpubNavigatorFragment
import org.readium.r2.navigator.epub.EpubPreferences
import org.readium.r2.navigator.input.InputListener
import org.readium.r2.navigator.input.TapEvent
import org.readium.r2.navigator.preferences.Color
import org.readium.r2.navigator.preferences.FontFamily
import org.readium.r2.navigator.preferences.ReadingProgression
import org.readium.r2.navigator.preferences.Spread
import org.readium.r2.navigator.preferences.Theme
import org.readium.r2.shared.ExperimentalReadiumApi
import org.readium.r2.shared.publication.Layout
import org.readium.r2.shared.publication.Link
import org.readium.r2.shared.publication.Locator
import org.readium.r2.shared.publication.Publication
import org.readium.r2.shared.publication.indexOfFirstWithHref
import org.readium.r2.shared.util.AbsoluteUrl
import org.readium.r2.shared.util.use
import java.util.Date
import kotlin.math.roundToInt

/** A book opened in the background, with its contents list built there too. */
/** [sections] when the book has no table of contents and [toc] lists its files instead. */
private class OpenedBook(val publication: Publication, val toc: List<TocEntry>, val sections: Boolean)

@OptIn(ExperimentalReadiumApi::class)
class MainActivity : AppCompatActivity() {
	private enum class Section { STYLES, CONTENTS, LIBRARY, SETTINGS }

	private val app get() = application as SquidreadApplication
	private val prefs get() = app.prefs
	private val library get() = app.library
	private val fonts get() = app.fonts

	private lateinit var readerArea: ReaderFrame
	private lateinit var navigatorContainer: View
	private lateinit var readerMessage: View
	private lateinit var readerMessageTitle: TextView
	private lateinit var readerIntro: View
	private lateinit var readerIntroLogo: View
	private lateinit var readerIntroZones: View
	private lateinit var readerSelect: View
	private lateinit var loadingView: View
	private lateinit var loadingCover: ImageView
	private lateinit var loadingTitle: TextView
	private lateinit var clockView: TextView
	private lateinit var chapterInfoView: TextView
	private lateinit var progressView: TextView
	private lateinit var menu: View
	private lateinit var systemBars: WindowInsetsControllerCompat
	private lateinit var barScrims: List<View>
	private lateinit var menuTitle: TextView
	private lateinit var fontSizeValue: TextView
	private lateinit var fontPicker: View
	private lateinit var fontName: TextView
	private lateinit var fontsMessage: TextView
	private lateinit var fontsFolderButton: View
	private lateinit var fontsHowToButton: View
	private lateinit var tocList: RecyclerView
	private lateinit var tocEmpty: TextView
	private lateinit var libraryList: RecyclerView
	private lateinit var sectionViews: Map<Section, View>
	private lateinit var tabViews: Map<Section, View>
	private var zoneButtons: List<TextView> = emptyList()
	private var themeButtons: Map<ThemeMode, TextView> = emptyMap()

	/** Whether the screen was built in the dark theme; it is built again when that changes. */
	private var isNight = false

	private val tocAdapter = TocAdapter { entry -> navigateTo(entry) }
	private lateinit var libraryAdapter: LibraryAdapter

	private var book: Book? = null
	private var publication: Publication? = null
	private var navigator: EpubNavigatorFragment? = null
	private var locatorJob: Job? = null
	private var openJob: Job? = null
	private var firstPageJob: Job? = null
	private var currentLocator: Locator? = null
	private var pageInChapter: String? = null
	private var section = Section.STYLES
	private var loadingTimeout: Job? = null
	private var awaitingFirstPage = false
	private var settingsBuilt = false
	private var coversPreloaded = false

	/** The footer changed while the menu covered it; it is updated when the menu closes. */
	private var footerStale = false

	/** A Contents jump to another chapter: the menu stays up until the page is ready. */
	private var pendingJump: Job? = null
	private var sectionTitlesJob: Job? = null
	private var showsSections = false

	/** Where links in the book were followed from; Back returns there. */
	private val linkHistory = ArrayDeque<Locator>()

	/** Taps reported by the book so far; each needs a touch on the reader of its own. */
	private var tapsUsed = 0

	private var footnoteDialog: AlertDialog? = null

	private var lastKeyTurn = 0L
	private var lastRendererGone = 0L
	private var trimScheduled = false

	/** Whether the system bars should be showing; the latest request wins. */
	private var barsWanted = false

	/** Font families the current navigator knows; choosing another one rebuilds it. */
	private var declaredFamilies: Set<String> = emptySet()

	/** The book this task is for, from its intent; null for the library task. */
	private var taskBookId: String? = null

	/** Set when the book was unloaded to save memory while in the background. */
	private var releasedBook: Book? = null

	private val pickDocument = registerForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
		// Importing and opening a new task is the launcher's job, as for "Open with".
		uri?.let {
			startActivity(
				Intent(this, LauncherActivity::class.java)
					.setAction(Intent.ACTION_VIEW)
					.setData(it)
					.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),
			)
		}
	}

	private val pickFontsFolder = registerForActivityResult(ActivityResultContracts.OpenDocumentTree()) { uri ->
		uri?.let {
			fonts.setFolder(it)
			refreshFonts()
		}
	}

	private val clockReceiver = object : BroadcastReceiver() {
		override fun onReceive(context: Context, intent: Intent) = updateClock()
	}

	/** Wraps each page's web view as Readium creates it; see [GuardedWebViewClient]. */
	private val webViewGuard = object : FragmentManager.FragmentLifecycleCallbacks() {
		override fun onFragmentViewCreated(fm: FragmentManager, f: Fragment, v: View, savedInstanceState: Bundle?) {
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) guardWebViews(v)
		}
	}

	override fun onCreate(savedInstanceState: Bundle?) {
		// The navigator is rebuilt from the saved locator, so a restored one is a placeholder,
		// removed at once. The rest of the saved state is kept: it carries the results of the
		// file and folder pickers when the system recreated the app while they were open.
		supportFragmentManager.fragmentFactory = EpubNavigatorFragment.createDummyFactory()
		super.onCreate(savedInstanceState)
		supportFragmentManager.findFragmentByTag(NAVIGATOR_TAG)?.let { restored ->
			supportFragmentManager.commitNow(allowStateLoss = true) { remove(restored) }
		}
		supportFragmentManager.registerFragmentLifecycleCallbacks(webViewGuard, true)

		// Start reading the book first; building the screen happens meanwhile.
		taskBookId = BookTasks.bookId(intent)
		val taskBook = taskBookId?.let { library.get(it) }
		val opening = taskBook?.let(::startOpening)

		isNight = isNightMode()
		setContentView(R.layout.activity_main)
		bindViews()
		setUpWindow()
		setUpMenu()
		updateFontSizeLabel()

		readerArea.onBackgroundTap = { x, y -> handleTap(x, y) }
		readerArea.onKey = ::handlePageKey

		onBackPressedDispatcher.addCallback(this) {
			val nav = navigator
			when {
				menu.isVisible -> closeMenu()
				nav != null && linkHistory.isNotEmpty() -> nav.go(linkHistory.removeAt(linkHistory.lastIndex), animated = false)
				else -> moveTaskToBack(true)
			}
		}

		if (taskBook != null && opening != null) {
			openBook(taskBook, opening)
		} else {
			if (taskBookId != null) {
				toast(R.string.open_failed)
				// The book is gone; this task now works like the library task.
				taskBookId = null
			}
			showNoBook(true)
			// With no books, the screen behind the menu says how to get started.
			if (library.all().isNotEmpty()) openMenu(Section.LIBRARY)
			// Shows the library once, with its covers.
			window.decorView.holdDrawing(lifecycleScope, LIBRARY_WAIT_MS) { preloadCovers() }
		}
		// Rebuilt for a new theme: back to the menu section that was showing, usually Settings.
		savedInstanceState?.getString(MENU_SECTION)
			?.let { name -> Section.entries.firstOrNull { it.name == name } }
			?.let(::openMenu)
	}

	override fun onSaveInstanceState(outState: Bundle) {
		super.onSaveInstanceState(outState)
		if (menu.isVisible) outState.putString(MENU_SECTION, section.name)
	}

	override fun onNewIntent(intent: Intent) {
		super.onNewIntent(intent)
		// The same file imported again finds its old task, which may have lost its book.
		val id = BookTasks.bookId(intent) ?: return
		// Opening the book again goes straight to its page, even if the menu was left open.
		if (navigator != null) closeMenu()
		if (id == book?.id || id == releasedBook?.id || openJob?.isActive == true) return
		library.get(id)?.let { selected ->
			taskBookId = id
			openBook(selected)
		}
	}

	override fun onStart() {
		super.onStart()
		app.readers.remove(this)
		app.readers.add(this)
		releasedBook?.let { released ->
			releasedBook = null
			openBook(released)
		}
		scheduleTrim()
		updateClock()
		val filter = IntentFilter().apply {
			addAction(Intent.ACTION_TIME_TICK)
			addAction(Intent.ACTION_TIME_CHANGED)
			addAction(Intent.ACTION_TIMEZONE_CHANGED)
		}
		ContextCompat.registerReceiver(this, clockReceiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
	}

	override fun onStop() {
		library.flush()
		unregisterReceiver(clockReceiver)
		super.onStop()
	}

	override fun onResume() {
		super.onResume()
		// The launcher icon returns to the most recently read book, and the library lists it first.
		taskBookId?.let { id ->
			prefs.lastBookId = id
			if (library.get(id) != null) library.touch(id)
		}
	}

	override fun onDestroy() {
		app.readers.remove(this)
		publication?.close()
		super.onDestroy()
	}

	override fun onTrimMemory(level: Int) {
		super.onTrimMemory(level)
		// While another book is open the app is in the foreground, so only the running levels
		// arrive; of those, only critical means memory is really short.
		val pressure = level >= TRIM_MEMORY_BACKGROUND || level == TRIM_MEMORY_RUNNING_CRITICAL
		if (pressure && !isStarted()) releaseBook()
		// The shared covers are dropped at these levels; decode them again before the library shows.
		if (CoverCache.evicts(level)) coversPreloaded = false
	}

	override fun onConfigurationChanged(newConfig: Configuration) {
		super.onConfigurationChanged(newConfig)
		// Every view takes its colours when built, so a new theme builds the screen again.
		if (isNightMode() != isNight) {
			recreate()
			return
		}
		// Rotation is handled in place; pick up the margins and columns for the new shape.
		val top = resources.getDimensionPixelSize(R.dimen.reader_padding_top)
		val bottom = resources.getDimensionPixelSize(R.dimen.reader_padding_bottom)
		if (navigatorContainer.paddingTop != top || navigatorContainer.paddingBottom != bottom) {
			navigatorContainer.updatePadding(top = top, bottom = bottom)
		}
		(libraryList.layoutManager as GridLayoutManager).let { grid ->
			val columns = libraryColumns()
			if (grid.spanCount != columns) grid.spanCount = columns
		}
	}

	private fun isStarted() = lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

	/**
	 * Every task lives in one process, so each open book would keep its web views in memory.
	 * Keep the most recently shown few loaded; the rest reload when shown again.
	 */
	private fun trimLoadedReaders() {
		val loaded = app.readers.filter { it.navigator != null }
		loaded.dropLast(MAX_LOADED_READERS).filterNot { it.isStarted() }.forEach { it.releaseBook() }
	}

	/** Unloading another book destroys its web views; that waits until this one is drawn. */
	private fun scheduleTrim() {
		if (trimScheduled) return
		trimScheduled = true
		Looper.myQueue().addIdleHandler {
			trimScheduled = false
			trimLoadedReaders()
			false
		}
	}

	private fun releaseBook() {
		val current = book ?: return
		Log.i(TAG, "Unloading ${current.id} while in the background")
		closeBook()
		releasedBook = current
	}

	override fun dispatchKeyEvent(event: KeyEvent): Boolean {
		if (handlePageKey(event)) return true
		if (event.action == KeyEvent.ACTION_DOWN && handleKey(event.keyCode)) return true
		return super.dispatchKeyEvent(event)
	}

	/** Turns pages for page keys while reading; also called by the reader before Android sees them. */
	private fun handlePageKey(event: KeyEvent): Boolean {
		if (!isPageKey(event.keyCode) || menu.isVisible || navigator == null) return false
		// A held key repeats far faster than e-ink can show pages: turn one per refresh, and
		// keep the key from the web view, which has nothing to do with it.
		if (event.action == KeyEvent.ACTION_DOWN &&
			(event.repeatCount == 0 || event.eventTime - lastKeyTurn >= KEY_REPEAT_MS)
		) {
			lastKeyTurn = event.eventTime
			handleKey(event.keyCode)
		}
		return true
	}

	private fun isPageKey(keyCode: Int) = keyCode == KeyEvent.KEYCODE_PAGE_UP || keyCode == KeyEvent.KEYCODE_PAGE_DOWN ||
		keyCode == KeyEvent.KEYCODE_DPAD_LEFT || keyCode == KeyEvent.KEYCODE_DPAD_RIGHT

	// --- Setup ---------------------------------------------------------------

	/**
	 * The system bars are hidden while reading and shown only with the menu. They draw over the
	 * reader rather than resizing it, so showing them never re-paginates the book; only the
	 * menu makes room for them, with scrims in the page colour behind the bars.
	 */
	private fun setUpWindow() {
		val root = findViewById<View>(R.id.root)
		WindowCompat.setDecorFitsSystemWindows(window, false)
		systemBars = WindowInsetsControllerCompat(window, root).apply {
			hide(WindowInsetsCompat.Type.systemBars())
			systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
			isAppearanceLightStatusBars = !isNight
			isAppearanceLightNavigationBars = !isNight
		}
		val scrims = listOf(R.id.bar_scrim_top, R.id.bar_scrim_bottom, R.id.bar_scrim_left, R.id.bar_scrim_right)
			.map { findViewById<View>(it) }
		barScrims = scrims
		ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
			// The cutout doesn't come and go, so it is safe to lay the reader out around it.
			val cutout = insets.getInsets(WindowInsetsCompat.Type.displayCutout())
			view.updatePadding(left = cutout.left, top = cutout.top, right = cutout.right, bottom = cutout.bottom)

			// The bars' size whether or not they are showing, so the menu is laid out once, before
			// it appears, and doesn't move when the bars come and go.
			val bars = insets.getInsetsIgnoringVisibility(WindowInsetsCompat.Type.systemBars())
			val left = (bars.left - cutout.left).coerceAtLeast(0)
			val top = (bars.top - cutout.top).coerceAtLeast(0)
			val right = (bars.right - cutout.right).coerceAtLeast(0)
			val bottom = (bars.bottom - cutout.bottom).coerceAtLeast(0)
			menu.updatePadding(left = left, top = top, right = right, bottom = bottom)
			scrims[0].setSize(height = top)
			scrims[1].setSize(height = bottom)
			scrims[2].setSize(width = left)
			scrims[3].setSize(width = right)
			WindowInsetsCompat.CONSUMED
		}
	}

	private fun View.setSize(width: Int = layoutParams.width, height: Int = layoutParams.height) {
		if (layoutParams.width != width || layoutParams.height != height) {
			updateLayoutParams {
				this.width = width
				this.height = height
			}
		}
	}

	private fun bindViews() {
		readerArea = findViewById(R.id.reader_area)
		navigatorContainer = findViewById(R.id.navigator_container)
		readerMessage = findViewById(R.id.reader_message)
		readerMessageTitle = findViewById(R.id.reader_message_title)
		readerIntro = findViewById(R.id.reader_intro)
		readerIntroLogo = findViewById(R.id.reader_intro_logo)
		readerIntroZones = findViewById(R.id.reader_intro_zones)
		readerSelect = findViewById(R.id.reader_select)
		findViewById<View>(R.id.reader_message_content).setOnClickListener { openMenu(Section.LIBRARY) }
		readerSelect.setOnClickListener { openMenu(Section.LIBRARY) }
		findViewById<View>(R.id.reader_add).setOnClickListener { pickEpub() }
		findViewById<View>(R.id.reader_example).setOnClickListener {
			openExternal(Uri.parse(getString(R.string.gutenberg_example_url)))
		}
		findViewById<View>(R.id.reader_more).setOnClickListener {
			openExternal(Uri.parse(getString(R.string.gutenberg_url)))
		}
		findViewById<TextView>(R.id.reader_intro_tip).setText(if (isBoox) R.string.default_tip_boox else R.string.default_tip_android)
		findViewById<View>(R.id.reader_how_to).setOnClickListener {
			openExternal(Uri.parse(getString(R.string.default_url)))
		}
		loadingView = findViewById(R.id.loading)
		loadingCover = findViewById(R.id.loading_cover)
		loadingTitle = findViewById(R.id.loading_title)
		clockView = findViewById(R.id.clock)
		chapterInfoView = findViewById(R.id.chapter_info)
		progressView = findViewById(R.id.progress)
		menu = findViewById(R.id.menu)
		menuTitle = findViewById(R.id.menu_title)
		fontSizeValue = findViewById(R.id.font_size_value)
		fontPicker = findViewById(R.id.font_picker)
		fontName = findViewById(R.id.font_name)
		fontsMessage = findViewById(R.id.fonts_message)
		fontsFolderButton = findViewById(R.id.fonts_folder)
		fontsHowToButton = findViewById(R.id.fonts_how_to)
		tocList = findViewById(R.id.toc_list)
		tocEmpty = findViewById(R.id.toc_empty)
		libraryList = findViewById(R.id.library_list)
		sectionViews = mapOf(
			Section.STYLES to findViewById(R.id.section_styles),
			Section.CONTENTS to findViewById(R.id.section_contents),
			Section.LIBRARY to libraryList,
			Section.SETTINGS to findViewById(R.id.section_settings),
		)
		tabViews = mapOf(
			Section.STYLES to findViewById(R.id.tab_styles),
			Section.CONTENTS to findViewById(R.id.tab_contents),
			Section.LIBRARY to findViewById(R.id.tab_library),
			Section.SETTINGS to findViewById(R.id.tab_settings),
		)
	}

	private fun setUpMenu() {
		findViewById<View>(R.id.close_menu).setOnClickListener { closeMenu() }
		chapterInfoView.setOnClickListener { if (navigator != null) openMenu(Section.CONTENTS) }
		tabViews.forEach { (tab, view) -> view.setOnClickListener { showSection(tab) } }

		findViewById<View>(R.id.font_decrease).setOnClickListener { changeFontSize(-ReaderPreferences.FONT_SIZE_STEP) }
		findViewById<View>(R.id.font_increase).setOnClickListener { changeFontSize(ReaderPreferences.FONT_SIZE_STEP) }
		findViewById<View>(R.id.font_reset).setOnClickListener { setFontSize(1.0) }
		findViewById<View>(R.id.font_previous).setOnClickListener { cycleFont(-1) }
		findViewById<View>(R.id.font_next).setOnClickListener { cycleFont(1) }
		fontName.setOnClickListener { chooseFont() }
		fontsHowToButton.setOnClickListener { openExternal(Uri.parse(getString(R.string.fonts_url))) }
		fontsFolderButton.setOnClickListener {
			try {
				pickFontsFolder.launch(fonts.initialFolder)
			} catch (error: ActivityNotFoundException) {
				toast(R.string.open_failed)
			}
		}

		tocList.layoutManager = LinearLayoutManager(this)
		tocList.itemAnimator = null
		tocList.adapter = tocAdapter

		libraryAdapter = LibraryAdapter(
			library = library,
			covers = app.covers,
			scope = lifecycleScope,
			onAdd = ::pickEpub,
			onOpen = { selected ->
				if (selected.id == taskBookId) {
					if (book == null && openJob?.isActive != true) openBook(selected) else closeMenu()
				} else {
					startActivity(BookTasks.intent(this, selected.id))
					// The library-only task has served its purpose once a book is chosen.
					if (taskBookId == null) finishAndRemoveTask() else closeMenu()
				}
			},
			onDelete = { selected -> confirmDelete(selected) },
			onLink = { url -> openExternal(Uri.parse(getString(url))) },
			emptyHint = getString(if (isBoox) R.string.library_hint_boox else R.string.library_hint_android),
		)
		libraryList.layoutManager = GridLayoutManager(this, libraryColumns()).apply {
			spanSizeLookup = object : GridLayoutManager.SpanSizeLookup() {
				override fun getSpanSize(position: Int) = if (libraryAdapter.isFullRow(position)) spanCount else 1
			}
		}
		libraryList.itemAnimator = null
		libraryList.adapter = libraryAdapter
	}

	private fun libraryColumns() = (resources.configuration.screenWidthDp / LIBRARY_COLUMN_DP).coerceIn(2, 6)

	/** The books that fit on the first screen of the library, after the "Add EPUB" tile. */
	private fun firstScreenOfBooks(): Int {
		val configuration = resources.configuration
		val columns = libraryColumns()
		val tileHeight = configuration.screenWidthDp / columns * 3 / 2 + LIBRARY_TITLE_DP
		val rows = configuration.screenHeightDp / tileHeight.coerceAtLeast(1) + 1
		return columns * rows - 1
	}

	private suspend fun preloadCovers() {
		coversPreloaded = true
		libraryAdapter.preload(firstScreenOfBooks())
	}

	/** Built the first time Settings is opened; most sessions never open it. */
	private fun setUpSettings() {
		if (settingsBuilt) return
		settingsBuilt = true
		val content = findViewById<LinearLayout>(R.id.settings_content)
		content.addView(heading(R.string.theme_heading))
		val themes = LinearLayout(this).apply {
			// Room for the outer half of the shared borders, which overlap the row's edge.
			setPadding(dp(1), 0, dp(1), 0)
			clipToPadding = false
		}
		themeButtons = listOf(
			ThemeMode.SYSTEM to R.string.theme_system,
			ThemeMode.LIGHT to R.string.theme_light,
			ThemeMode.DARK to R.string.theme_dark,
		).associate { (mode, text) ->
			mode to button(getString(text)) { chooseTheme(mode) }.also { view ->
				themes.addView(
					view,
					LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f).apply { setMargins(-dp(1), 0, -dp(1), 0) },
				)
			}
		}
		// Segmented, like the tabs: neighbouring buttons overlap by a border's width and share it.
		content.addView(themes, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
		updateThemeButtons()

		content.addView(heading(R.string.zones_heading))
		val grid = GridLayout(this).apply {
			columnCount = 3
			rowCount = 3
			// Room for the outer half of the shared borders, which overlap the grid's edge.
			setPadding(dp(1), dp(1), dp(1), dp(1))
			clipToPadding = false
		}
		zoneButtons = List(9) { index ->
			button("") { cycleZone(index) }.also { view ->
				grid.addView(
					view,
					GridLayout.LayoutParams(
						GridLayout.spec(index / 3, 1f),
						GridLayout.spec(index % 3, 1f),
					).apply {
						width = 0
						height = dp(64)
						setMargins(-dp(1), -dp(1), -dp(1), -dp(1))
					},
				)
			}
		}
		content.addView(grid, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
		content.addView(label(R.string.zones_hint))
		updateZoneButtons()

		content.addView(heading(R.string.app_name))
		content.addView(
			label(getString(R.string.version_label, packageManager.getPackageInfo(packageName, 0).versionName)).apply {
				gravity = android.view.Gravity.START
				setPadding(0, 0, 0, dp(12))
			},
			LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT),
		)
		val links = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply {
			topMargin = dp(8)
		}
		content.addView(button(getString(R.string.website)) { openExternal(Uri.parse(getString(R.string.website_url))) }, links)
		content.addView(button(getString(R.string.privacy)) { openExternal(Uri.parse(getString(R.string.privacy_url))) }, links)
		content.addView(button(getString(R.string.licenses)) { showLicenses() }, links)
	}

	/** The notices the libraries' licenses ask to be shown with the app; readable offline. */
	private fun showLicenses() {
		val text = assets.open(LICENSES_ASSET).bufferedReader().use { it.readText() }
		AlertDialog.Builder(this)
			.setTitle(R.string.licenses)
			.setMessage(text)
			.setPositiveButton(android.R.string.ok, null)
			.show()
	}

	// --- Opening books ---------------------------------------------------------

	/**
	 * Opens [selected] in the background. It always runs to the end, even if the screen goes
	 * away, so the result is never dropped unclosed; it is closed if nobody takes it.
	 */
	private fun startOpening(selected: Book): Deferred<OpenedBook?> = lifecycleScope.async(Dispatchers.IO + NonCancellable) {
		app.readium.open(library.file(selected.id))?.let { opened ->
			val toc = buildToc(opened.tableOfContents)
			if (toc.isNotEmpty()) {
				OpenedBook(opened, toc, sections = false)
			} else {
				val sections = buildSections(opened.readingOrder) { number -> getString(R.string.toc_section, number) }
				OpenedBook(opened, sections, sections = true)
			}
		}
	}

	@OptIn(ExperimentalCoroutinesApi::class)
	private fun Deferred<OpenedBook?>.closeWhenDone() = invokeOnCompletion { error ->
		if (error == null) getCompleted()?.publication?.close()
	}

	private fun openBook(selected: Book, opening: Deferred<OpenedBook?> = startOpening(selected)) {
		openJob?.cancel()
		showLoading(selected)
		openJob = lifecycleScope.launch {
			// The navigator declares every font so switching between them never reloads it. The
			// last listing of the folder is enough for that; it is listed again once the book shows.
			val scan = if (fonts.folder != null && !fonts.restore()) async { fonts.ensureScanned() } else null
			val opened = try {
				opening.await()
			} catch (error: CancellationException) {
				opening.closeWhenDone()
				throw error
			}
			var unclaimed = opened
			try {
				scan?.await()
				if (opened == null) {
					openFailed(selected)
					return@launch
				}
				unclaimed = null
				showBook(selected, opened)
			} finally {
				unclaimed?.publication?.close()
			}
		}
	}

	/** Labels this task in recents with the book's title and cover. */
	private suspend fun updateTaskDescription(selected: Book) {
		val cover = app.covers.load(selected.id, library.coverFile(selected.id))
		// Deprecated, but the only form that takes a bitmap icon on every Android version
		// (the builder's Icon setter isn't available on all devices).
		@Suppress("DEPRECATION")
		setTaskDescription(ActivityManager.TaskDescription(selected.title, cover))
	}

	private fun openFailed(selected: Book) {
		hideLoading()
		updateFooter()
		toast(R.string.open_failed)
		// A freshly imported file that isn't a readable EPUB shouldn't stay in the library.
		if (selected.pendingMetadata) {
			library.delete(selected.id)
			if (prefs.lastBookId == selected.id) prefs.lastBookId = null
			// This task's book is gone; it now works like the library task.
			if (taskBookId == selected.id) taskBookId = null
		}
		showNoBook(true)
		openMenu(Section.LIBRARY)
	}

	/**
	 * Covers the reader with the book's cover and title from the moment it is chosen until its
	 * first page is drawn, so there is immediate feedback and no flash of the previous book.
	 */
	private fun showLoading(selected: Book) {
		closeMenu()
		showNoBook(false)
		loadingTitle.text = selected.title
		val coverFile = library.coverFile(selected.id)
		val cached = app.covers.cached(selected.id)
		loadingCover.setImageBitmap(cached)
		// No empty frame for books without a cover (every book the first time it opens).
		loadingCover.isVisible = cached != null || coverFile.exists()
		loadingView.isVisible = true
		// The footer belongs to the book being replaced; blank it until the new one reports.
		chapterInfoView.setTextIfChanged("")
		progressView.setTextIfChanged("")
		if (cached == null && loadingCover.isVisible) {
			// Wait a moment for the cover, so the screen appears once, with it.
			window.decorView.holdDrawing(lifecycleScope, COVER_WAIT_MS) {
				val bitmap = app.covers.load(selected.id, coverFile)
				if (bitmap == null) loadingCover.isVisible = false else loadingCover.setImageBitmap(bitmap)
			}
		}
		// The web view engine starts while the book is parsed, once the loading screen is up.
		if (!app.isWebViewPrepared) loadingView.afterNextFrame { app.prepareWebView() }
		startLoadingTimeout()
	}

	/** Never leave the reader covered if Readium doesn't report a drawn page. */
	private fun startLoadingTimeout() {
		loadingTimeout?.cancel()
		loadingTimeout = lifecycleScope.launch {
			delay(LOADING_TIMEOUT_MS)
			hideLoading()
		}
	}

	private fun hideLoading() {
		loadingTimeout?.cancel()
		loadingView.isVisible = false
		loadingCover.setImageDrawable(null)
		// In the same frame that reveals the page.
		if (footerStale && !menu.isVisible) {
			footerStale = false
			updateFooter()
			updateClock()
		}
	}

	/**
	 * Lets the chapters Readium preloads on either side draw while offscreen, so crossing
	 * into the next chapter shows a finished page right away.
	 */
	private fun preRasterWebViews(view: View?) {
		when (view) {
			is WebView -> if (!view.settings.offscreenPreRaster) view.settings.offscreenPreRaster = true
			is ViewGroup -> for (index in 0 until view.childCount) preRasterWebViews(view.getChildAt(index))
		}
	}

	@RequiresApi(Build.VERSION_CODES.O)
	private fun guardWebViews(view: View) {
		when (view) {
			is WebView -> {
				val client = view.webViewClient
				if (client !is GuardedWebViewClient) {
					view.webViewClient = GuardedWebViewClient(client, ::openExternal, ::onRendererGone)
				}
			}
			is ViewGroup -> for (index in 0 until view.childCount) guardWebViews(view.getChildAt(index))
		}
	}

	/**
	 * The web view renderer, shared by every open book, crashed or was killed. Each web view
	 * reports it; the first report replaces the book's web views. A book that crashes it again
	 * right away isn't retried.
	 */
	private fun onRendererGone(crashed: Boolean) {
		readerArea.post {
			val current = book ?: return@post
			Log.w(TAG, if (crashed) "Web view renderer crashed" else "Web view renderer was stopped")
			closeBook()
			val now = SystemClock.uptimeMillis()
			when {
				!isStarted() -> releasedBook = current
				now - lastRendererGone > RENDERER_RETRY_MS -> {
					lastRendererGone = now
					openBook(current)
				}
				else -> {
					toast(R.string.open_failed)
					showNoBook(true)
					openMenu(Section.LIBRARY)
				}
			}
		}
	}

	private fun showBook(selected: Book, opened: OpenedBook) {
		closeBook()
		book = selected
		publication = opened.publication
		menuTitle.text = selected.title
		tocAdapter.submit(opened.toc)
		showsSections = opened.sections
		if (opened.sections) findSectionTitles(opened)

		val initialLocator = selected.locator?.let { json ->
			runCatching { Locator.fromJSON(JSONObject(json)) }.getOrNull()
		}
		try {
			attachNavigator(opened.publication, initialLocator)
		} catch (error: RuntimeException) {
			// Readium rejected the book while building the reader.
			Log.w(TAG, "Cannot show ${selected.id}: ${error.javaClass.simpleName}")
			runCatching { closeBook() }.onFailure { publication?.close() }
			publication = null
			book = null
			navigator = null
			openFailed(selected)
			return
		}
		tocList.layoutDirection = if (isRtl()) View.LAYOUT_DIRECTION_RTL else View.LAYOUT_DIRECTION_LTR
		scheduleTrim()
	}

	/** Rebuilds the navigator in place, for fonts added to the folder since the book opened. */
	private fun reloadNavigator() {
		val opened = publication ?: return
		locatorJob?.cancel()
		attachNavigator(opened, currentLocator)
	}

	private fun attachNavigator(opened: Publication, locator: Locator?) {
		// Before any web view exists, so no book's script runs with cookies on. Usually done
		// already, while the book was parsed.
		app.prepareWebView()
		val configuration = EpubNavigatorFragment.Configuration(shouldApplyInsetsPadding = false)
		val families = fonts.families
		fonts.declare(configuration, families)
		declaredFamilies = families.map { it.family }.toSet()
		supportFragmentManager.fragmentFactory = EpubNavigatorFactory(opened).createFragmentFactory(
			initialLocator = locator,
			initialPreferences = epubPreferences(),
			listener = navigatorListener,
			paginationListener = paginationListener,
			configuration = configuration,
		)
		// State loss is fine: the navigator is always rebuilt from the saved locator.
		supportFragmentManager.commitNow(allowStateLoss = true) {
			replace(R.id.navigator_container, EpubNavigatorFragment::class.java, null, NAVIGATOR_TAG)
		}
		val fragment = supportFragmentManager.findFragmentByTag(NAVIGATOR_TAG) as EpubNavigatorFragment
		navigator = fragment
		readerArea.requestFocus()
		awaitingFirstPage = true
		if (loadingView.isVisible) startLoadingTimeout()
		fragment.addInputListener(object : InputListener {
			override fun onTap(event: TapEvent): Boolean {
				// A real tap reaches here well within the window; anything later is a script.
				val recent = SystemClock.uptimeMillis() - readerArea.lastUpTime <= LINK_TAP_WINDOW_MS
				if (recent && takeTapCredit()) handleTap(readerArea.lastDownX, readerArea.lastDownY)
				return true
			}
		})
		// Fixed-layout pages can be zoomed and panned, so swipes stay theirs.
		readerArea.onSwipe = if (opened.metadata.layout == Layout.FIXED) null else { leftward -> onSwipe(leftward) }
		locatorJob = lifecycleScope.launch {
			fragment.currentLocator.collect { locator -> onLocatorChanged(locator) }
		}
	}

	private fun closeBook() {
		locatorJob?.cancel()
		locatorJob = null
		firstPageJob?.cancel()
		firstPageJob = null
		pendingJump?.cancel()
		pendingJump = null
		readerArea.onSwipe = null
		linkHistory.clear()
		footnoteDialog?.dismiss()
		footnoteDialog = null
		navigator?.let { fragment -> supportFragmentManager.commitNow(allowStateLoss = true) { remove(fragment) } }
		navigator = null
		// The factory holds the publication; let it go with the navigator.
		supportFragmentManager.fragmentFactory = FragmentFactory()
		sectionTitlesJob?.cancel()
		sectionTitlesJob = null
		showsSections = false
		publication?.close()
		publication = null
		book = null
		currentLocator = null
		pageInChapter = null
		menuTitle.setText(R.string.app_name)
		tocAdapter.submit(emptyList())
		updateFooter()
	}

	private fun confirmDelete(selected: Book) {
		AlertDialog.Builder(this)
			.setTitle(R.string.delete_title)
			.setMessage(selected.title)
			.setPositiveButton(R.string.delete) { _, _ ->
				library.delete(selected.id)
				if (prefs.lastBookId == selected.id) prefs.lastBookId = null
				if (selected.id == taskBookId) {
					finishAndRemoveTask()
				} else {
					BookTasks.remove(this, selected.id)
					libraryAdapter.refresh(book?.id)
				}
			}
			.setNegativeButton(R.string.cancel, null)
			.show()
	}

	private val navigatorListener = object : EpubNavigatorFragment.Listener {
		// Links outside the book arrive here only where the web views can't be guarded (Android 7);
		// elsewhere GuardedWebViewClient handles them. Only links the reader just tapped open.
		override fun onExternalLinkActivated(url: AbsoluteUrl) {
			if (SystemClock.uptimeMillis() - readerArea.lastUpTime > LINK_TAP_WINDOW_MS) return
			openExternal(Uri.parse(url.toString()))
		}

		override fun shouldFollowInternalLink(link: Link, context: HyperlinkNavigator.LinkContext?): Boolean {
			// A footnote opens over the page, where reading continues once it is dismissed. One
			// at a time, and only for a touch on the reader.
			if (context is HyperlinkNavigator.FootnoteContext) {
				if (!menu.isVisible && footnoteDialog?.isShowing != true && takeTapCredit()) {
					footnoteDialog = showFootnote(context.noteContent)
				}
				return false
			}
			// The pager shows only the reading order; anything else (a non-linear note, an image)
			// would go nowhere.
			val target = link.url().removeFragment()
			if (publication?.readingOrder?.any { it.url().isEquivalent(target) } != true) return false
			val last = linkHistory.lastOrNull()
			if (last != null && last.href.removeFragment().isEquivalent(target)) {
				// Following a link back to where the last one was followed from, as notes do.
				linkHistory.removeAt(linkHistory.lastIndex)
			} else {
				currentLocator?.let { here ->
					linkHistory.addLast(here)
					if (linkHistory.size > MAX_LINK_HISTORY) linkHistory.removeAt(0)
				}
			}
			return true
		}
	}

	private val paginationListener = object : EpubNavigatorFragment.PaginationListener {
		override fun onPageLoaded() {
			// Readium loads the chapters on either side too; only the one being opened counts.
			if (awaitingFirstPage && isCurrentPageShowing()) onFirstPageShown()
		}

		override fun onPageChanged(pageIndex: Int, totalPages: Int, locator: Locator) {
			// Only reported once the current page is in place.
			if (awaitingFirstPage) onFirstPageShown()
			// Readium counts columns from the left; right-to-left books start on the rightmost one.
			val page = if (isRtl()) totalPages - pageIndex else pageIndex + 1
			pageInChapter = "$page/$totalPages"
			updateFooter()
			if (pendingJump != null) closeMenu()
			preRasterWebViews(navigator?.view)
		}
	}

	/**
	 * Spends the credit a touch on the reader earns, so a book's script, which can report taps
	 * and footnotes of its own, can't act without one.
	 */
	private fun takeTapCredit(): Boolean {
		tapsUsed = maxOf(tapsUsed, readerArea.upCount - MAX_PENDING_TAPS)
		if (tapsUsed >= readerArea.upCount) return false
		tapsUsed++
		return true
	}

	/** Whether the page the pager is showing has loaded; Readium hides it until then. */
	private fun isCurrentPageShowing(): Boolean {
		val page = navigator?.childFragmentManager?.fragments?.firstOrNull { it.isMenuVisible } ?: return true
		val webView = page.view?.let(::findWebView) ?: return true
		return webView.isVisible
	}

	private fun findWebView(view: View): WebView? = when (view) {
		is WebView -> view
		is ViewGroup -> (0 until view.childCount).firstNotNullOfOrNull { findWebView(view.getChildAt(it)) }
		else -> null
	}

	/** The book's first page is on screen: reveal it, then do what could wait until now. */
	private fun onFirstPageShown() {
		awaitingFirstPage = false
		hideLoading()
		// The web views exist now, and with them the web view's own crash handler.
		app.watchForCrashes()
		val current = book ?: return
		val opened = publication ?: return
		if (firstPageJob != null) return
		firstPageJob = lifecycleScope.launch {
			if (current.pendingMetadata) {
				library.completeMetadata(current, opened)
				menuTitle.text = current.title
			}
			updateTaskDescription(current)
			// A font added or removed since the folder was last listed.
			if (fonts.folder != null && !fonts.isScanned) refreshFonts()
			if (!coversPreloaded) {
				delay(COVER_PRELOAD_DELAY_MS)
				preloadCovers()
			}
		}
	}

	private fun onLocatorChanged(locator: Locator) {
		currentLocator = locator
		book?.let { library.saveLocator(it.id, locator.toJSON().toString()) }
		updateFooter()
	}

	private fun epubPreferences() = EpubPreferences(
		fontSize = prefs.fontSize,
		fontFamily = currentFontFamily()?.takeIf { it in declaredFamilies }?.let(::FontFamily),
		spread = Spread.NEVER,
		scroll = false,
		theme = if (isNight) Theme.DARK else Theme.LIGHT,
		// Maximum contrast for e-ink, whatever greys the book asks for.
		textColor = Color(ContextCompat.getColor(this, R.color.ink)),
		backgroundColor = Color(ContextCompat.getColor(this, R.color.paper)),
	)

	// --- Navigation ------------------------------------------------------------

	private fun isRtl() = navigator?.settings?.value?.readingProgression == ReadingProgression.RTL

	private fun goNext() {
		navigator?.goForward(animated = false)
	}

	private fun goPrevious() {
		navigator?.goBackward(animated = false)
	}

	private fun onSwipe(leftward: Boolean) {
		if (menu.isVisible || loadingView.isVisible || navigator == null) return
		// Swiping left brings in the page on the right: the next one in a left-to-right book.
		if (leftward != isRtl()) goNext() else goPrevious()
	}

	private fun navigateTo(entry: TocEntry) {
		// A jump from the contents starts a new trail; Back no longer returns to old links.
		linkHistory.clear()
		val nav = navigator ?: return closeMenu()
		val opened = publication ?: return closeMenu()
		val here = currentLocator?.href?.removeFragment()?.toString()
		val moved = nav.go(entry.link, animated = false)
		// Readium pages only through the reading order; non-linear items and broken links go nowhere.
		val pages = moved && opened.readingOrder.indexOfFirstWithHref(entry.link.url()) != null
		val sameChapter = here == entry.path
		// Only a jump to the start of the loaded chapter is applied at once.
		if (!pages || here == null || opened.metadata.layout == Layout.FIXED ||
			(sameChapter && entry.link.url().fragment == null)
		) {
			closeMenu()
			return
		}
		// Otherwise the page appears a little later (another chapter loads blank, an anchor is
		// scrolled to by script): keep the contents up until it is ready, so the screen goes
		// straight to it.
		if (!sameChapter) tocAdapter.setActive(entry)
		pendingJump?.cancel()
		pendingJump = lifecycleScope.launch {
			delay(if (sameChapter) SAME_CHAPTER_JUMP_TIMEOUT_MS else JUMP_TIMEOUT_MS)
			closeMenu()
		}
	}

	/**
	 * Names the sections of a book without a table of contents after the first heading in each,
	 * in the background, so the book opens as fast as any other. Until then they are numbered.
	 */
	private fun findSectionTitles(opened: OpenedBook) {
		sectionTitlesJob = lifecycleScope.launch {
			val titles = withContext(Dispatchers.IO) {
				opened.toc.map { entry ->
					runCatching {
						opened.publication.get(entry.link)?.use { it.read(0L until SECTION_HEADING_BYTES) }
							?.getOrNull()?.let { bytes -> firstHeading(bytes.decodeToString()) }
					}.getOrNull()
				}
			}
			if (publication !== opened.publication || titles.all { it == null }) return@launch
			tocAdapter.submit(opened.toc.withTitles(titles))
			updateFooter()
		}
	}

	private fun showFootnote(html: String): AlertDialog {
		val dialog = AlertDialog.Builder(this)
			.setMessage(HtmlCompat.fromHtml(html, HtmlCompat.FROM_HTML_MODE_COMPACT).trimEnd())
			.setPositiveButton(android.R.string.ok, null)
			.create()
		val dialogWindow = dialog.window
		// A dialog that takes focus brings the hidden system bars back on older Android versions,
		// animating them in and out. It asks for them hidden before it gets focus.
		dialogWindow?.addFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
		dialog.show()
		dialogWindow?.let { window ->
			WindowCompat.getInsetsController(window, window.decorView).apply {
				systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
				hide(WindowInsetsCompat.Type.systemBars())
			}
			window.clearFlags(WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE)
		}
		return dialog
	}

	/** Tap position is relative to [readerArea], which spans the full width above the footer. */
	private fun handleTap(x: Float, y: Float) {
		if (menu.isVisible) return
		if (navigator == null) {
			openMenu(Section.LIBRARY)
			return
		}
		val width = readerArea.width
		val height = readerArea.height
		if (width <= 0 || height <= 0) return

		val column = (x / width * 3).toInt().coerceIn(0, 2)
		val row = (y / height * 3).toInt().coerceIn(0, 2)
		// Zones are configured for left-to-right books; mirror the grid for right-to-left,
		// so each action keeps its meaning and moves to the opposite side.
		val zone = if (isRtl()) 2 - column else column
		when (prefs.zones[row * 3 + zone]) {
			ZoneAction.MENU -> openMenu()
			ZoneAction.NEXT -> goNext()
			ZoneAction.PREV -> goPrevious()
		}
	}

	private fun handleKey(keyCode: Int): Boolean {
		if (menu.isVisible) {
			if (keyCode == KeyEvent.KEYCODE_ESCAPE) {
				closeMenu()
				return true
			}
			return false
		}
		if (navigator == null) return false
		when (keyCode) {
			KeyEvent.KEYCODE_PAGE_DOWN -> goNext()
			KeyEvent.KEYCODE_PAGE_UP -> goPrevious()
			KeyEvent.KEYCODE_DPAD_RIGHT -> if (isRtl()) goPrevious() else goNext()
			KeyEvent.KEYCODE_DPAD_LEFT -> if (isRtl()) goNext() else goPrevious()
			KeyEvent.KEYCODE_M, KeyEvent.KEYCODE_MENU -> openMenu()
			else -> return false
		}
		return true
	}

	// --- Footer ----------------------------------------------------------------

	private fun updateFooter() {
		val locator = currentLocator
		val entry = locator?.let { tocAdapter.entryFor(it) }
		tocAdapter.setActive(entry)
		// Hidden under the menu or the loading screen: drawing it would refresh part of the screen
		// for nothing.
		if (menu.isVisible || loadingView.isVisible) {
			footerStale = true
			return
		}

		val info = listOfNotNull(entry?.title, pageInChapter).joinToString(" • ")
		chapterInfoView.setTextIfChanged(if (locator == null) "" else info.ifEmpty { "•" })
		val chapterNumber =
			if (entry != null && tocAdapter.topLevelCount > 0) "${entry.number}/${tocAdapter.topLevelCount}" else "-"
		val percent = locator?.locations?.totalProgression?.let { "${(it * 100).roundToInt()}%" } ?: "-"
		progressView.setTextIfChanged(if (locator == null) "" else "$chapterNumber • $percent")
	}

	private fun updateClock() {
		if (menu.isVisible) {
			footerStale = true
			return
		}
		clockView.setTextIfChanged(DateFormat.getTimeFormat(this).format(Date()))
	}

	/** Avoids redrawing unchanged text, which costs a refresh on e-ink. */
	private fun TextView.setTextIfChanged(value: String) {
		if (text.toString() != value) text = value
	}

	/**
	 * The screen behind the menu while no book is open. An empty library gets what the screen is
	 * for and where books come from; otherwise there's a way back to the library.
	 */
	private fun showNoBook(visible: Boolean) {
		readerMessage.isVisible = visible
		if (!visible) return
		val empty = library.all().isEmpty()
		readerMessageTitle.setTextIfChanged(getString(if (empty) R.string.reader_intro_title else R.string.no_book))
		readerIntroLogo.isVisible = empty
		readerIntro.isVisible = empty
		readerIntroZones.isVisible = prefs.zones == ReaderPreferences.DEFAULT_ZONES
		readerSelect.isVisible = !empty
	}

	private fun pickEpub() {
		try {
			pickDocument.launch(EPUB_MIME_TYPES)
		} catch (error: ActivityNotFoundException) {
			toast(R.string.open_failed)
		}
	}

	// --- Menu ------------------------------------------------------------------

	private fun openMenu(target: Section = if (navigator == null) Section.LIBRARY else section) {
		showSection(target)
		menu.isVisible = true
		barScrims.forEach { it.isVisible = true }
		setSystemBarsVisible(true)
	}

	private fun closeMenu() {
		pendingJump?.cancel()
		pendingJump = null
		if (!menu.isVisible) return
		menu.isVisible = false
		barScrims.forEach { it.isVisible = false }
		setSystemBarsVisible(false)
		readerArea.requestFocus()
		// Books may have come or gone while the menu was open.
		if (readerMessage.isVisible) showNoBook(true)
		// In the same frame that reveals the footer.
		if (footerStale) {
			footerStale = false
			updateFooter()
			updateClock()
		}
	}

	/**
	 * Shows or hides the system bars at once. Asked plainly, Android fades them in over half a
	 * second and out over one and a half: a long run of refreshes on e-ink.
	 */
	private fun setSystemBarsVisible(visible: Boolean) {
		barsWanted = visible
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) {
			val types = WindowInsetsCompat.Type.systemBars()
			if (visible) systemBars.show(types) else systemBars.hide(types)
			return
		}
		// Separately: a bar the app can't take control of holds up any request that includes it.
		snapBars(WindowInsetsCompat.Type.statusBars())
		snapBars(WindowInsetsCompat.Type.navigationBars())
	}

	/** Moves [types] straight to their final state, or animates them as usual if that isn't possible. */
	@RequiresApi(Build.VERSION_CODES.R)
	private fun snapBars(types: Int) {
		val cancel = CancellationSignal()
		var settled = false
		fun fallback() {
			if (settled) return
			settled = true
			if (barsWanted) systemBars.show(types) else systemBars.hide(types)
		}
		systemBars.controlWindowInsetsAnimation(
			types,
			-1L,
			null,
			cancel,
			object : WindowInsetsAnimationControlListenerCompat {
				override fun onReady(controller: WindowInsetsAnimationControllerCompat, types: Int) {
					if (settled) return
					settled = true
					controller.finish(barsWanted)
				}

				override fun onFinished(controller: WindowInsetsAnimationControllerCompat) = Unit

				override fun onCancelled(controller: WindowInsetsAnimationControllerCompat?) = fallback()
			},
		)
		// Control normally arrives within a frame. Some bars never grant it (the navigation
		// handle on recent Android versions, for one).
		readerArea.postDelayed({
			if (!settled) {
				cancel.cancel()
				fallback()
			}
		}, BAR_CONTROL_TIMEOUT_MS)
	}

	private fun showSection(target: Section) {
		section = target
		sectionViews.forEach { (key, view) -> view.isVisible = key == target }
		tabViews.forEach { (key, view) -> view.isSelected = key == target }
		when (target) {
			Section.LIBRARY -> libraryAdapter.refresh(book?.id)
			Section.CONTENTS -> {
				val empty = tocAdapter.itemCount == 0
				tocEmpty.isVisible = empty || showsSections
				when {
					empty -> tocEmpty.setText(if (navigator == null) R.string.no_contents else R.string.no_toc)
					showsSections -> tocEmpty.setText(R.string.toc_sections)
				}
				tocAdapter.activeIndex.takeIf { it >= 0 }?.let { tocList.scrollToPosition(it) }
			}
			Section.STYLES -> refreshFonts()
			Section.SETTINGS -> setUpSettings()
		}
	}

	private fun changeFontSize(delta: Double) = setFontSize(prefs.fontSize + delta)

	private fun setFontSize(value: Double) {
		// Round to one decimal so repeated steps don't drift.
		prefs.fontSize = ((value * 10).roundToInt() / 10.0)
			.coerceIn(ReaderPreferences.MIN_FONT_SIZE, ReaderPreferences.MAX_FONT_SIZE)
		navigator?.submitPreferences(epubPreferences())
		updateFontSizeLabel()
	}

	private fun updateFontSizeLabel() {
		fontSizeValue.text = "${(prefs.fontSize * 100).roundToInt()}%"
	}

	/** Shows the fonts known so far right away, then again if listing the folder finds changes. */
	private fun refreshFonts() {
		updateFontPicker()
		lifecycleScope.launch {
			val before = epubPreferences().fontFamily
			fonts.scan()
			updateFontPicker()
			// A chosen font removed from the folder falls back to the book's fonts.
			if (epubPreferences().fontFamily != before) navigator?.submitPreferences(epubPreferences())
		}
	}

	/** The family in use: null for the book's own fonts, or when the chosen one is gone. */
	private fun currentFontFamily(): String? = prefs.fontFamily?.takeIf { fonts.family(it) != null }

	private fun fontOptions(): List<String?> = listOf(null) + fonts.families.map { it.family }

	private fun updateFontPicker() {
		val families = fonts.families
		val access = fonts.hasAccess()
		fontPicker.isVisible = families.isNotEmpty()
		fontName.setTextIfChanged(currentFontFamily() ?: getString(R.string.book_font))
		val message = when {
			!access -> getString(R.string.fonts_no_access)
			families.isEmpty() -> getString(R.string.fonts_empty, fonts.folderName)
			else -> null
		}
		fontsMessage.isVisible = message != null
		message?.let { fontsMessage.setTextIfChanged(it) }
		// Also offered for an empty folder, in case the wrong one was chosen.
		fontsFolderButton.isVisible = families.isEmpty()
		fontsHowToButton.isVisible = access && families.isEmpty()
	}

	private fun cycleFont(step: Int) {
		val options = fontOptions()
		val index = options.indexOf(currentFontFamily())
		setFontFamily(options[(index + step).mod(options.size)])
	}

	private fun chooseFont() {
		val options = fontOptions()
		val labels = options.map { it ?: getString(R.string.book_font) }.toTypedArray()
		AlertDialog.Builder(this)
			.setTitle(R.string.font)
			.setSingleChoiceItems(labels, options.indexOf(currentFontFamily())) { dialog, which ->
				dialog.dismiss()
				setFontFamily(options[which])
			}
			.show()
	}

	private fun setFontFamily(family: String?) {
		prefs.fontFamily = family
		updateFontPicker()
		if (family != null && family !in declaredFamilies) reloadNavigator() else navigator?.submitPreferences(epubPreferences())
	}

	private fun cycleZone(index: Int) {
		val zones = prefs.zones.toMutableList()
		zones[index] = ZoneAction.entries[(zones[index].ordinal + 1) % ZoneAction.entries.size]
		prefs.zones = zones
		updateZoneButtons()
	}

	private fun chooseTheme(mode: ThemeMode) {
		if (prefs.theme == mode) return
		prefs.theme = mode
		updateThemeButtons()
		// Screens whose colours change are rebuilt, through onConfigurationChanged.
		app.applyTheme()
	}

	private fun updateThemeButtons() {
		themeButtons.forEach { (mode, view) -> view.isSelected = mode == prefs.theme }
	}

	private fun isNightMode() =
		resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES

	private fun updateZoneButtons() {
		prefs.zones.forEachIndexed { index, action ->
			zoneButtons.getOrNull(index)?.setText(
				when (action) {
					ZoneAction.PREV -> R.string.zone_prev
					ZoneAction.MENU -> R.string.zone_menu
					ZoneAction.NEXT -> R.string.zone_next
				},
			)
		}
	}

	// --- Helpers ---------------------------------------------------------------

	/**
	 * Opens a web or mail link in another app. Links come from books, so anything else (other
	 * apps' own schemes, the book's internal addresses, absurdly long URLs) is ignored.
	 */
	private fun openExternal(uri: Uri) {
		if (uri.scheme?.lowercase() !in EXTERNAL_SCHEMES || isInBook(uri)) return
		if (uri.toString().length > MAX_LINK_LENGTH) return
		try {
			startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
		} catch (error: ActivityNotFoundException) {
			toast(R.string.open_failed)
		} catch (error: RuntimeException) {
			Log.w(TAG, "Cannot open link: ${error.javaClass.simpleName}")
			toast(R.string.open_failed)
		}
	}

	private fun toast(message: Int) = Toast.makeText(this, message, Toast.LENGTH_SHORT).show()

	private fun dp(value: Int) = (value * resources.displayMetrics.density).roundToInt()

	private fun heading(text: Int) = TextView(this, null, 0, R.style.Squidread_Heading).apply { setText(text) }

	private fun label(text: Int) = label(getString(text))

	private fun label(text: String) = TextView(this).apply {
		this.text = text
		setTextColor(ContextCompat.getColor(context, R.color.ink))
		textSize = 15f
		gravity = android.view.Gravity.CENTER
		setPadding(0, dp(12), 0, dp(8))
	}

	private fun button(text: String, onClick: () -> Unit) =
		TextView(this, null, 0, R.style.Squidread_Button).apply {
			this.text = text
			setOnClickListener { onClick() }
		}

	private companion object {
		const val TAG = "Squidread"
		const val NAVIGATOR_TAG = "navigator"
		const val MENU_SECTION = "menuSection"
		const val LICENSES_ASSET = "licenses.txt"
		const val LOADING_TIMEOUT_MS = 10_000L
		const val COVER_WAIT_MS = 150L
		const val LIBRARY_WAIT_MS = 300L
		const val COVER_PRELOAD_DELAY_MS = 2_000L
		const val JUMP_TIMEOUT_MS = 3_000L
		const val SAME_CHAPTER_JUMP_TIMEOUT_MS = 500L
		/** Where a section's first heading is looked for: its opening bytes. */
		const val SECTION_HEADING_BYTES = 16_384L
		const val KEY_REPEAT_MS = 250L
		const val BAR_CONTROL_TIMEOUT_MS = 100L
		const val RENDERER_RETRY_MS = 10_000L
		const val LINK_TAP_WINDOW_MS = 1_500L
		const val MAX_PENDING_TAPS = 2
		const val MAX_LINK_HISTORY = 20
		const val MAX_LINK_LENGTH = 4096
		const val MAX_LOADED_READERS = 3
		const val LIBRARY_COLUMN_DP = 140
		const val LIBRARY_TITLE_DP = 48
		val EXTERNAL_SCHEMES = setOf("http", "https", "mailto")
		val EPUB_MIME_TYPES = arrayOf("application/epub+zip", "application/octet-stream", "application/zip")

		/** Boox devices are made by Onyx; their library sets the default reader its own way. */
		val isBoox = Build.MANUFACTURER.equals("ONYX", ignoreCase = true) || Build.BRAND.equals("BOOX", ignoreCase = true)
	}
}
