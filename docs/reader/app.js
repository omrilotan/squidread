import { openDB } from './vendor/idb.js';

const libraryEl = document.getElementById('library');
const closePanelBtn = document.getElementById('closePanel');
const swRefreshLink = document.getElementById('swRefreshLink');
const panelEl = document.getElementById('panel');
const filePicker = document.getElementById('filePicker');
const toastEl = document.getElementById('toast');
const viewerEl = document.getElementById('viewer');
const readerEl = document.querySelector('.reader');
const readerFooterEl = document.querySelector('.readerFooter');
const tocListEl = document.getElementById('tocList');
const progressEl = document.getElementById('progress');
const progressFillEl = document.getElementById('progressFill');
const progressLabelEl = document.getElementById('progressLabel');
const clockEl = document.getElementById('clock');
const chapterInfoEl = document.getElementById('chapterInfo');
const chapterNumberEl = document.getElementById('chapterNumber');
const progressPercentEl = document.getElementById('progressPercent');
const menuTitleEl = document.getElementById('menuTitle');
const librarySectionEl = document.getElementById('librarySection');
const viewerEmptyStateEl = document.getElementById('viewerEmptyState');
const viewerEmptyTitleEl = document.getElementById('viewerEmptyTitle');
const selectBookBtn = document.getElementById('selectBookBtn');
const readerIntroEl = document.getElementById('readerIntro');
const readerIntroZonesEl = document.getElementById('readerIntroZones');
const searchRowEl = document.getElementById('searchRow');
const searchFieldEl = document.getElementById('searchField');
const searchClearEl = document.getElementById('searchClear');
const searchStatusEl = document.getElementById('searchStatus');
const searchListEl = document.getElementById('searchList');
const searchBarEl = document.getElementById('searchBar');
const searchPositionEl = document.getElementById('searchPosition');
const searchPreviousEl = document.getElementById('searchPrevious');
const searchNextEl = document.getElementById('searchNext');
const librarySearchRowEl = document.getElementById('librarySearchRow');
const librarySearchFieldEl = document.getElementById('librarySearchField');
const librarySearchClearEl = document.getElementById('librarySearchClear');
const bookEndEl = document.getElementById('bookEnd');
const bookEndTitleEl = document.getElementById('bookEndTitle');
const deleteDialogEl = document.getElementById('deleteDialog');
const noteDialogEl = document.getElementById('noteDialog');

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

// --- Lazy-load heavy reader deps -------------------------------------------
// EPUB.js (+ JSZip) are large; loading them only when needed keeps startup fast.
// Exact versions, checked against their hashes: a changed file never runs.
const EPUB_SCRIPTS = [
  {
    src: 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    integrity: 'sha384-+mbV2IY1Zk/X1p/nWllGySJSUN8uMs+gUAN10Or95UBH0fpj6GfKgPmgC5EXieXG',
  },
  {
    src: 'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
    integrity: 'sha384-ZqmkDa/1AGF4SKdSmXgEG+3G+Gsb6yNqUSq2Mqp0jDf1GWk+UY5eNbEd7hgwiywI',
  },
];
let epubDepsPromise = null;
const MAX_BOOK_BYTES = 500 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 4 * 1024 * 1024;
const MAX_TITLE_LENGTH = 500;
const MAX_TOC_DEPTH = 32;
const MAX_INDENT_DEPTH = 6;
const DC_NAMESPACE = 'http://purl.org/dc/elements/1.1/';
const OPS_NAMESPACE = 'http://www.idpf.org/2007/ops';
// The book can make a note anything; a note is never this long.
const MAX_NOTE_LENGTH = 16 * 1024;
const MARKS = /\p{Mn}+/gu;
const GUTENBERG_EXAMPLE_URL = 'https://www.gutenberg.org/ebooks/345.epub3.images';
const GUTENBERG_URL = 'https://www.gutenberg.org/ebooks/search/?sort_order=downloads';
const NAVIGATION_WAIT_MS = 2000;
// Books in these languages read right to left when they don't say which way they go.
const RTL_LANGUAGES = new Set(['ar', 'fa', 'he']);

function loadScript({ src, integrity }) {
  return new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.dataset.loaded === '1') return resolve();
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.async = true;
    script.onload = () => {
      script.dataset.loaded = '1';
      resolve();
    };
    script.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(script);
  });
}

async function ensureEpubDepsLoaded() {
  if (typeof window.ePub === 'function') return;
  if (!epubDepsPromise) {
    epubDepsPromise = (async () => {
      for (const script of EPUB_SCRIPTS) await loadScript(script);
      if (typeof window.ePub !== 'function') {
        throw new Error('EPUB deps loaded, but window.ePub is not available');
      }
    })();
  }
  await epubDepsPromise;
}

// --- Logging utility --------------------------------------------------------
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
function getInitialLogLevel() {
  const qp = new URLSearchParams(location.search).get('log');
  const stored = localStorage.getItem('squidreadLogLevel');
  const level = (qp || stored || 'info').toLowerCase();
  return LOG_LEVELS[level] != null ? level : 'info';
}
let currentLogLevel = getInitialLogLevel();
function setLogLevel(level) {
  if (LOG_LEVELS[level] == null) return;
  currentLogLevel = level;
  localStorage.setItem('squidreadLogLevel', level);
}
const log = {
  debug: (...args) => {
    if (LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.debug) console.debug('[squidread]', ...args);
  },
  info: (...args) => {
    if (LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.info) console.info('[squidread]', ...args);
  },
  warn: (...args) => {
    if (LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.warn) console.warn('[squidread]', ...args);
  },
  error: (...args) => {
    if (LOG_LEVELS[currentLogLevel] <= LOG_LEVELS.error) console.error('[squidread]', ...args);
  },
  setLevel: setLogLevel,
  get level() { return currentLogLevel; }
};
// Expose for quick toggling in dev
window.squidreadLog = log;

let db;
let book;
let rendition;
let currentRecord;
let locationsReady = false;
let toastTimer;
let lastFileProgressLogged = -1;
let lastFetchProgressLogged = -1;
let isProcessing = false;
let isRTL = false;
let fixedViewerHeight = window.innerHeight;
let currentFontSize = 1.0; // Track font size multiplier from default (1em = 100%)
let isTurningPage = false;
let resizeTimer = null;
let lastClockUpdate = 0;
// The contents list, flat, as numbered in the footer; sections stand in for a missing one.
let tocEntries = [];
let showsSections = false;
// Where links were followed from, so Back returns there; see followLink.
const linkHistory = [];
const MAX_LINK_HISTORY = 20;
let ignoredPops = 0;
// Where the reader was when the font size last changed, kept until the page is turned.
let keptPlace = null;
let placeTimer = null;
const KEEP_PLACE_MS = 150;
const KEEP_PLACE_TRIES = 3;
let touchStart = null;
let lastSwipeAt = 0;
const SWIPE_DISTANCE = 40;
const SWIPE_CLICK_MS = 500;
const READER_ASPECT_PRESETS = {
  fullscreen: null,
  '16:9': 16 / 9,
  '4:3': 4 / 3,
  '1:1': 1,
};
const READER_ASPECT_DIRECTIONS = new Set(['device', 'portrait', 'landscape']);
let readerAspectPreset = 'fullscreen';
let readerAspectDirection = 'device';

// Zone action mapping: row/col -> action ('prev', 'next', or 'menu')
// Zones are configured for left-to-right books; the grid is mirrored for RTL (Right to Left) books
function getDefaultZoneMap() {
  return {
    '0,0': 'prev', '0,1': 'menu', '0,2': 'next',
    '1,0': 'prev', '1,1': 'menu', '1,2': 'next',
    '2,0': 'prev', '2,1': 'menu', '2,2': 'next',
  };
}
let zoneActionMap = getDefaultZoneMap();

function loadZoneMapFromStorage() {
  const stored = localStorage.getItem('squidreadZoneMap');
  if (stored) {
    try {
      zoneActionMap = JSON.parse(stored);
    } catch (e) {
      log.warn('Failed to load zone map from storage', e);
      zoneActionMap = getDefaultZoneMap();
    }
  }
}

function saveZoneMapToStorage() {
  localStorage.setItem('squidreadZoneMap', JSON.stringify(zoneActionMap));
}

function isValidReaderAspectPreset(preset) {
  return Object.prototype.hasOwnProperty.call(READER_ASPECT_PRESETS, preset);
}

function isValidReaderAspectDirection(direction) {
  return READER_ASPECT_DIRECTIONS.has(direction);
}

function getEffectiveReaderAspectDirection() {
  if (readerAspectDirection === 'device') {
    return window.matchMedia('(orientation: portrait)').matches ? 'portrait' : 'landscape';
  }
  return readerAspectDirection;
}

function getReaderAspectRatioValue() {
  if (readerAspectPreset === 'fullscreen') {
    return null;
  }

  const baseRatio = READER_ASPECT_PRESETS[readerAspectPreset];
  if (!Number.isFinite(baseRatio)) {
    return null;
  }

  return getEffectiveReaderAspectDirection() === 'portrait' ? 1 / baseRatio : baseRatio;
}

function applyReaderAspectRatio() {
  if (!viewerEl) return;

  if (readerAspectPreset === 'fullscreen') {
    viewerEl.style.removeProperty('--reader-aspect-ratio');
    viewerEl.classList.remove('hasAspectRatio');
    return;
  }

  const ratio = getReaderAspectRatioValue();
  if (!ratio) return;

  viewerEl.style.setProperty('--reader-aspect-ratio', String(ratio));
  viewerEl.classList.add('hasAspectRatio');
}

function saveReaderAspectSettings() {
  localStorage.setItem('squidreadReaderAspectPreset', readerAspectPreset);
  localStorage.setItem('squidreadReaderAspectDirection', readerAspectDirection);
}

function loadReaderAspectSettings() {
  const storedPreset = localStorage.getItem('squidreadReaderAspectPreset');
  const storedDirection = localStorage.getItem('squidreadReaderAspectDirection');

  if (isValidReaderAspectPreset(storedPreset)) {
    readerAspectPreset = storedPreset;
  }

  if (isValidReaderAspectDirection(storedDirection)) {
    readerAspectDirection = storedDirection;
  }
}

function syncReaderAspectControls() {
  const presetButtons = document.querySelectorAll('[data-aspect-preset]');
  const directionButtons = document.querySelectorAll('[data-aspect-direction]');
  if (!presetButtons.length || !directionButtons.length) return;

  presetButtons.forEach((button) => {
    const pressed = button.dataset.aspectPreset === readerAspectPreset;
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  });

  const directionDisabled = readerAspectPreset === 'fullscreen';
  directionButtons.forEach((button) => {
    const pressed = button.dataset.aspectDirection === readerAspectDirection;
    button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    button.disabled = directionDisabled;
  });
}

function wireReaderAspectControls() {
  const presetButtons = document.querySelectorAll('[data-aspect-preset]');
  const directionButtons = document.querySelectorAll('[data-aspect-direction]');
  if (!presetButtons.length || !directionButtons.length) return;

  syncReaderAspectControls();

  presetButtons.forEach((button) => {
    button.addEventListener('click', () => {
      const nextPreset = button.dataset.aspectPreset;
      if (!isValidReaderAspectPreset(nextPreset)) return;
      readerAspectPreset = nextPreset;
      syncReaderAspectControls();
      applyReaderAspectRatio();
      queueViewerRedraw();
      saveReaderAspectSettings();
    });
  });

  directionButtons.forEach((button) => {
    button.addEventListener('click', () => {
      if (readerAspectPreset === 'fullscreen') {
        syncReaderAspectControls();
        return;
      }

      const nextDirection = button.dataset.aspectDirection;
      if (!isValidReaderAspectDirection(nextDirection)) return;
      readerAspectDirection = nextDirection;
      syncReaderAspectControls();
      applyReaderAspectRatio();
      queueViewerRedraw();
      saveReaderAspectSettings();
    });
  });
}

(async function init() {
  log.info('App init start');
  db = await openDB('squidread', 1, {
    upgrade(upgradeDB) {
      upgradeDB.createObjectStore('books', { keyPath: 'id' });
    },
  });

  loadZoneMapFromStorage();
  loadReaderAspectSettings();
  applyReaderAspectRatio();
  wireEvents();
  const savedFontSize = parseFloat(localStorage.getItem('squidreadFontSize'));
  if (savedFontSize > 0) currentFontSize = savedFontSize;
  applyFontSize();
  await renderLibrary();
  await refreshEmptyState();

  // Load the last opened book if available
  const lastOpenedBookId = localStorage.getItem('lastOpenedBookId');
  try {
    if (lastOpenedBookId) {
      const lastRecord = await db.get('books', lastOpenedBookId);
      if (lastRecord) {
        log.info('Loading last opened book:', lastOpenedBookId);
        await loadBook(lastOpenedBookId);
      } else {
        localStorage.removeItem('lastOpenedBookId');
      }
    }

    if (!lastOpenedBookId || !currentRecord) {
      const books = await db.getAll('books');
      if (books.length) {
        books.sort((a, b) => b.createdAt - a.createdAt);
        log.info('Loading most recent book:', books[0].id);
        await loadBook(books[0].id);
      } else {
        // The empty reader says what it's for and where books come from.
        log.info('No books in library');
      }
    }
  } catch (error) {
    log.warn('Failed to load last opened book:', error);
  }
  
  registerServiceWorker();
  log.info('App init complete; log level:', log.level);
  
  // Start clock
  updateClock();
  setInterval(updateClock, 1000);
  
  // Handle files opened via PWA file handler
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      if (launchParams.files && launchParams.files.length > 0) {
        const fileHandle = launchParams.files[0];
        const file = await fileHandle.getFile();
        await handleLocalFile(file);
      }
    });
  }
})();

function wireEvents() {
  log.debug('Wiring UI events');
  const handleViewerPointer = (event) => {
    const target = event.target;
    if (!isDomElement(target)) return;
    // The reader's own controls act for themselves; taps around them work as tap zones.
    if (typeof target.closest === 'function' && target.closest('a[href], button, .readerFooter, .searchBar')) return;
    handleViewerZoneClick(event.clientX, event.clientY);
  };
  readerEl?.addEventListener('click', handleViewerPointer, true);
  readerEl?.addEventListener('touchstart', handleTouchStart, { passive: true });
  readerEl?.addEventListener('touchend', handleTouchEnd);
  closePanelBtn.addEventListener('click', () => closePanel());
  swRefreshLink?.addEventListener('click', async (event) => {
    event.preventDefault();
    await refreshServiceWorker();
    window.location.reload();
  });

  // Wire up navigation buttons
  document.getElementById('navLibrary')?.addEventListener('click', () => switchPanelSection('library'));
  document.getElementById('navContents')?.addEventListener('click', () => switchPanelSection('contents'));
  document.getElementById('navStyles')?.addEventListener('click', () => switchPanelSection('styles'));
  document.getElementById('navSettings')?.addEventListener('click', () => switchPanelSection('settings'));

  // Wire up font size controls
  document.getElementById('fontSizeDecrease')?.addEventListener('click', () => adjustFontSize(-0.1));
  document.getElementById('fontSizeReset')?.addEventListener('click', () => resetFontSize());
  document.getElementById('fontSizeIncrease')?.addEventListener('click', () => adjustFontSize(0.1));

  // Wire up the Add EPUB buttons to open file picker
  document.getElementById('addEpubBtn')?.addEventListener('click', () => filePicker.click());
  document.getElementById('introAddBtn')?.addEventListener('click', () => filePicker.click());
  selectBookBtn?.addEventListener('click', () => openPanel('library'));

  wireSearchEvents();
  wireBookEndEvents();
  document.getElementById('noteClose')?.addEventListener('click', () => noteDialogEl.close());
  document.getElementById('deleteCancel')?.addEventListener('click', () => deleteDialogEl.close());

  // Auto-start when a file is selected
  filePicker.addEventListener('change', async () => {
    const file = filePicker.files?.[0];
    if (!file) return;
    await handleLocalFile(file);
    // Reset the input so the same file can be selected again
    filePicker.value = '';
  });

  librarySectionEl?.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'copy';
    }
  });

  librarySectionEl?.addEventListener('drop', async (event) => {
    event.preventDefault();
    const file = getDroppedEpubFile(event.dataTransfer);
    if (!file) {
      showToast('Drop an EPUB file');
      return;
    }
    await handleLocalFile(file);
  });

  libraryEl.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;

    // Find the closest element with data-action
    const actionElement = target.closest('[data-action]');
    if (!actionElement) return;

    const id = actionElement.dataset.id;
    log.debug('Library action clicked:', { action: actionElement.dataset.action, id });
    if (!id) return;

    if (actionElement.matches('[data-action="open"]')) {
      log.info('Open action clicked for book ID:', id);
      // The next visit to the library starts with every book.
      setLibraryQuery('');
      if (currentRecord?.id === id) {
        closePanel();
      } else {
        await loadBook(id);
      }
    }

    if (actionElement.matches('[data-action="delete"]')) {
      await confirmDelete(id);
    }
  });

  tocListEl?.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('.tocItem');
    if (!button) return;
    const href = button.dataset.href;
    if (!href || !rendition) return;
    // A jump from the contents starts a new trail; Back no longer returns to old links.
    clearLinkHistory();
    showEnd(false);
    keptPlace = null;
    try {
      await rendition.display(href);
      closePanel();
    } catch (error) {
      // If direct display fails, try stripping fragment and matching in spine
      const targetSpine = findSpineItemByHref(href);
      
      if (targetSpine) {
        await rendition.display(targetSpine);
        closePanel();
      } else {
        log.warn('Failed to navigate to TOC item:', href, error);
      }
    }
  });

  chapterInfoEl?.addEventListener('click', () => {
    panelEl.classList.remove('hidden');
    switchPanelSection('contents');
  });

  window.addEventListener('resize', () => {
    applyReaderAspectRatio();
    queueViewerRedraw();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      persistCurrentLocation();
    }
  });

  window.addEventListener('beforeunload', () => {
    persistCurrentLocation();
  });

  window.addEventListener('keydown', (event) => {
    handleReaderKeydown(event);
  });

  // Back, in the browser or on the device, returns to where a link was followed from.
  window.addEventListener('popstate', () => {
    if (ignoredPops > 0) {
      ignoredPops--;
      return;
    }
    const origin = linkHistory.pop();
    if (origin && rendition) {
      showEnd(false);
      rendition.display(origin).catch((error) => log.warn('Failed to go back:', error));
    }
  });

  // Setup install modal handlers
  let deferredPrompt;
  const installModal = document.getElementById('installModal');
  const installBtn = document.getElementById('installBtn');
  const installDismiss = document.getElementById('installDismiss');
  const installModalClose = document.getElementById('installModalClose');

  if (installModal && installBtn && installDismiss && installModalClose) {
    const closeModal = () => {
      installModal.close();
      sessionStorage.setItem('dismissedInstall', 'true');
    };

    installBtn.addEventListener('click', async () => {
      if (deferredPrompt) {
        deferredPrompt.prompt();
        const { outcome } = await deferredPrompt.userChoice;
        log.info('Install outcome:', outcome);
        deferredPrompt = null;
      }
      closeModal();
    });

    installDismiss.addEventListener('click', closeModal);
    installModalClose.addEventListener('click', closeModal);

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      deferredPrompt = e;
      const dismissedInstall = sessionStorage.getItem('dismissedInstall');
      if (!dismissedInstall) {
        installModal.showModal();
      }
    });

    window.addEventListener('appinstalled', () => {
      installModal.close();
      log.info('App installed');
    });
  }

  // Wire up zone grid controls
  wireZoneGridEvents();
  wireThemeControls();
  wireReaderAspectControls();
}

const ZONE_ACTIONS = ['prev', 'menu', 'next'];
const ZONE_LABELS = { prev: '‹ Prev', menu: 'Menu', next: 'Next ›' };

// Same as the app: each zone shows its action, and tapping it moves to the next one.
function wireZoneGridEvents() {
  const zoneCells = document.querySelectorAll('.zoneCell');
  if (!zoneCells.length) return;

  const keyFor = (cell) => {
    const zone = parseInt(cell.dataset.zone, 10);
    return `${Math.floor(zone / 3)},${zone % 3}`;
  };
  const updateCell = (cell) => {
    cell.textContent = ZONE_LABELS[zoneActionMap[keyFor(cell)]] || ZONE_LABELS.menu;
  };

  zoneCells.forEach((cell) => {
    updateCell(cell);
    cell.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const key = keyFor(cell);
      const current = ZONE_ACTIONS.indexOf(zoneActionMap[key]);
      zoneActionMap[key] = ZONE_ACTIONS[(current + 1) % ZONE_ACTIONS.length];
      saveZoneMapToStorage();
      updateCell(cell);
      refreshEmptyState();
    });
  });
}

// --- Theme: System follows the device; Light and Dark override it. ---

const THEME_MODES = ['system', 'light', 'dark'];

function getThemeMode() {
  const stored = localStorage.getItem('squidreadTheme');
  return THEME_MODES.includes(stored) ? stored : 'system';
}

function applyThemeMode(mode) {
  if (mode === 'system') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = mode;
  }
  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    button.setAttribute('aria-pressed', button.dataset.themeMode === mode ? 'true' : 'false');
  });
  applyBookTheme();
}

/** The book's pages take the theme's two colours too, and so does a search match on them. */
function applyBookTheme() {
  if (!rendition) return;
  const styles = getComputedStyle(document.documentElement);
  rendition.themes.override('color', styles.getPropertyValue('--ink').trim(), true);
  rendition.themes.override('background', styles.getPropertyValue('--paper').trim(), true);
  rendition.getContents().forEach(markContents);
}

function wireThemeControls() {
  document.querySelectorAll('[data-theme-mode]').forEach((button) => {
    button.addEventListener('click', () => {
      const mode = button.dataset.themeMode;
      if (mode === 'system') {
        localStorage.removeItem('squidreadTheme');
      } else {
        localStorage.setItem('squidreadTheme', mode);
      }
      applyThemeMode(mode);
    });
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyBookTheme());
  applyThemeMode(getThemeMode());
}

// --- Search ------------------------------------------------------------------

// The words searched for, while their results replace the contents list; see searchBook.
let searchQuery = null;
let searchResults = [];
let searchIndex = -1;
// A new search, or a new book, stops the one before.
let searchRun = 0;
// Enough for any real search; a word as common as "the" stops here.
const MAX_SEARCH_RESULTS = 500;
// A match lower than this share of the page would be under the search bar.
const LOW_MATCH = 0.8;
const MATCH_HIGHLIGHT = 'squidread-match';
// Elements that start a new line of text, so words either side of them don't run together.
const TEXT_BREAKS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'td', 'th', 'tr', 'ul']);
const UNREAD = new Set(['script', 'style', 'noscript', 'template']);
const SNIPPET_BEFORE = 50;
const SNIPPET_AFTER = 80;

function wireSearchEvents() {
  searchFieldEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    searchBook(searchFieldEl.value);
  });
  searchFieldEl.addEventListener('input', () => searchClearEl.classList.toggle('hidden', !searchFieldEl.value));
  searchClearEl.addEventListener('click', () => endSearch());
  searchListEl.addEventListener('click', (event) => {
    const item = isDomElement(event.target) ? event.target.closest('.searchItem') : null;
    if (item) showResult(Number(item.dataset.index));
  });
  searchPreviousEl.addEventListener('click', () => showResult(searchIndex - 1));
  searchNextEl.addEventListener('click', () => showResult(searchIndex + 1));
  searchPositionEl.addEventListener('click', () => openPanel('contents'));
  document.getElementById('searchEnd')?.addEventListener('click', () => endSearch());

  librarySearchFieldEl.addEventListener('input', () => {
    completeAuthors();
    setLibraryQuery(librarySearchFieldEl.value);
  });
  librarySearchFieldEl.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') librarySearchFieldEl.blur();
  });
  librarySearchClearEl.addEventListener('click', () => setLibraryQuery(''));
}

/** Finds text in the whole book, a chapter at a time, and lists where it is. */
async function searchBook(text) {
  const query = text.trim().replace(/\s+/g, ' ');
  if (!query) return endSearch();
  const opened = book;
  if (!opened) return;
  const run = ++searchRun;
  searchFieldEl.blur();
  clearResult();
  searchQuery = query;
  searchResults = [];
  searchStatusEl.textContent = 'Searching…';
  showContents();

  const needle = foldMapped(query).text;
  const found = [];
  let failed = false;
  for (const section of opened.spine.spineItems) {
    if (found.length >= MAX_SEARCH_RESULTS) break;
    if (!section.linear) continue;
    try {
      found.push(...await withSectionDocument(opened, section, (doc) => findInDocument(doc, section, needle, MAX_SEARCH_RESULTS - found.length)));
    } catch (error) {
      log.warn('Could not search a section:', section.href, error);
      failed = true;
    }
    if (run !== searchRun) return;
    // Lets the page answer taps between chapters.
    await wait(0);
  }
  if (run !== searchRun || book !== opened) return;

  searchResults = found.map((result) => ({ ...result, chapter: tocEntryFor(result.href)?.title || '' }));
  const count = found.length;
  searchStatusEl.textContent = count === 0 && failed
    ? 'Could not search this book'
    : count === 0
      ? `No results for “${query}”`
      : count >= MAX_SEARCH_RESULTS
        ? `The first ${MAX_SEARCH_RESULTS} results`
        : count === 1 ? '1 result' : `${count} results`;
  showContents();
  searchListEl.scrollTop = 0;
}

/** Each place the folded needle is in the section, up to limit of them. */
function findInDocument(doc, section, needle, limit) {
  const root = doc.body || doc.documentElement;
  if (!root || !needle) return [];
  const { text, pieces } = documentText(doc, root);
  const folded = foldMapped(text);
  const results = [];
  for (let at = folded.text.indexOf(needle); at >= 0 && results.length < limit; at = folded.text.indexOf(needle, at + needle.length)) {
    const start = folded.starts[at];
    const end = folded.ends[at + needle.length - 1];
    const first = pieceAt(pieces, start);
    const last = pieceAt(pieces, end - 1);
    if (!first || !last) continue;
    const range = doc.createRange();
    range.setStart(first.node, start - first.start);
    range.setEnd(last.node, end - last.start);
    results.push({
      cfi: section.cfiFromRange(range),
      href: section.href,
      index: section.index,
      before: takeLastWords(collapse(text.slice(Math.max(0, start - 4 * SNIPPET_BEFORE), start)), SNIPPET_BEFORE),
      match: collapse(text.slice(start, end)),
      after: takeWords(collapse(text.slice(end, end + 4 * SNIPPET_AFTER)), SNIPPET_AFTER),
    });
  }
  return results;
}

/**
 * The text of the document as one string, and where each of its text nodes starts in it. A
 * space stands between text on different lines, so their words don't run together.
 */
function documentText(doc, root) {
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.nodeType === 1 && UNREAD.has(node.localName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const pieces = [];
  let text = '';
  let lastLine = null;
  let lineBreak = false;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === 1) {
      if (node.localName === 'br' || node.localName === 'hr') lineBreak = true;
      continue;
    }
    if (!node.data) continue;
    const line = lineOf(node, root);
    if (text && (lineBreak || line !== lastLine)) text += ' ';
    lastLine = line;
    lineBreak = false;
    pieces.push({ node, start: text.length });
    text += node.data;
  }
  return { text, pieces };
}

/** The element that starts the line the node is on. */
function lineOf(node, root) {
  for (let element = node.parentNode; element && element !== root; element = element.parentNode) {
    if (TEXT_BREAKS.has(element.localName)) return element;
  }
  return root;
}

/** The text node the character at index is in. */
function pieceAt(pieces, index) {
  let low = 0;
  let high = pieces.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (pieces[middle].start <= index) low = middle; else high = middle - 1;
  }
  const piece = pieces[low];
  return piece && index >= piece.start && index < piece.start + piece.node.data.length ? piece : null;
}

/**
 * The text folded as fold does, and for each of its characters where it starts and ends in the
 * text. Marks stay with the letter before them, so a match never cuts a letter off its points.
 */
function foldMapped(text) {
  const chars = [];
  const starts = [];
  const ends = [];
  let space = false;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i);
    const size = code > 0xffff ? 2 : 1;
    const char = code < 128 ? text[i] : text.slice(i, i + size);
    if (/\s/.test(char)) {
      if (!space) {
        chars.push(' ');
        starts.push(i);
        ends.push(i + size);
      }
      space = true;
    } else {
      const folded = code < 128 ? char.toLowerCase() : char.normalize('NFD').replace(MARKS, '').toLowerCase();
      if (folded) {
        for (const each of folded) {
          chars.push(each);
          starts.push(i);
          ends.push(i + size);
        }
        space = false;
      } else if (ends.length) {
        ends[ends.length - 1] = i + size;
      }
    }
    i += size;
  }
  return { text: chars.join(''), starts, ends };
}

function collapse(text) {
  return text.replace(/\s+/g, ' ');
}

/** The end of the text, from a word break, about length characters long. */
function takeLastWords(text, length) {
  if (text.length <= length) return text;
  const cut = text.length - length;
  const space = text.indexOf(' ', cut);
  return space < 0 || space - cut > length / 2 ? text.slice(cut) : text.slice(space);
}

/** The start of the text, up to a word break, about length characters long. */
function takeWords(text, length) {
  if (text.length <= length) return text;
  const space = text.lastIndexOf(' ', length);
  return space < length / 2 ? text.slice(0, length) : text.slice(0, space);
}

/** The contents list, or a search's results in its place. */
function showContents() {
  const searching = searchQuery !== null;
  searchStatusEl.classList.toggle('hidden', !searching);
  searchListEl.classList.toggle('hidden', !searching || !searchResults.length);
  tocListEl.classList.toggle('hidden', searching);
  if (searching) renderSearchResults();
}

function renderSearchResults() {
  if (searchListEl.childElementCount === searchResults.length && searchListEl.dataset.query === searchQuery) {
    markActiveResult();
    return;
  }
  searchListEl.innerHTML = '';
  searchListEl.dataset.query = searchQuery || '';
  searchResults.forEach((result, index) => {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.className = 'searchItem';
    button.dataset.index = index;
    if (result.chapter) {
      const chapter = document.createElement('span');
      chapter.className = 'searchChapter';
      chapter.dir = 'auto';
      chapter.textContent = result.chapter;
      button.appendChild(chapter);
    }
    // The match with some of the text around it, cut at word breaks, the match inverted.
    const text = document.createElement('span');
    text.className = 'searchText';
    text.dir = 'auto';
    const match = document.createElement('mark');
    match.textContent = result.match;
    text.append(result.before ? `…${result.before}` : '', match, result.after ? `${result.after}…` : '');
    button.appendChild(text);
    li.appendChild(button);
    searchListEl.appendChild(li);
  });
  markActiveResult();
}

function markActiveResult() {
  searchListEl.querySelector('.searchItem.active')?.classList.remove('active');
  const active = searchListEl.querySelector(`.searchItem[data-index="${searchIndex}"]`);
  active?.classList.add('active');
  active?.scrollIntoView({ block: 'nearest' });
}

/** Turns to a result and marks it there; the bar offers the others. */
async function showResult(index) {
  const result = searchResults[index];
  if (!result || !rendition) return;
  // A jump to a result starts a new trail; Back no longer returns to old links.
  clearLinkHistory();
  showEnd(false);
  keptPlace = null;
  searchIndex = index;
  updateSearchBar();
  markActiveResult();
  try {
    await rendition.display(result.cfi);
  } catch (error) {
    log.warn('Could not show a search result:', error);
  }
  closePanel();
  rendition.getContents().forEach(markContents);
  placeSearchBar();
}

/** Marks the result on the page, inverted like a selected button, if it is in this section. */
function markContents(contents) {
  const win = contents?.window;
  const doc = contents?.document;
  if (!win || !doc) return;
  const result = searchResults[searchIndex];
  const range = result ? matchRange(contents, result) : null;
  if (win.CSS?.highlights && typeof win.Highlight === 'function') {
    if (!range) {
      win.CSS.highlights.delete(MATCH_HIGHLIGHT);
      return;
    }
    let style = doc.getElementById('squidread-match-style');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'squidread-match-style';
      doc.head.appendChild(style);
    }
    style.textContent = matchStyle();
    win.CSS.highlights.set(MATCH_HIGHLIGHT, new win.Highlight(range));
    return;
  }
  // Without highlights: a white box over the match, blended by difference (see styles.css), inverts it the same.
  rendition.annotations.remove(markedCfi, 'highlight');
  markedCfi = null;
  if (range) {
    markedCfi = result.cfi;
    rendition.annotations.highlight(markedCfi, {}, null, MATCH_HIGHLIGHT, { fill: '#fff', 'fill-opacity': '1', 'mix-blend-mode': 'difference' });
  }
}
let markedCfi = null;

function matchStyle() {
  const styles = getComputedStyle(document.documentElement);
  return `::highlight(${MATCH_HIGHLIGHT}) { background-color: ${styles.getPropertyValue('--ink').trim()}; color: ${styles.getPropertyValue('--paper').trim()}; }`;
}

function matchRange(contents, result) {
  return contents.sectionIndex === result.index ? cfiRange(contents, result.cfi) : null;
}

/** The text at cfi, if it is in this section; null otherwise. */
function cfiRange(contents, cfi) {
  try {
    if (contents.sectionIndex !== new window.ePub.CFI(cfi).spinePos) return null;
    return contents.range(cfi);
  } catch (error) {
    log.debug('Could not find a place on the page:', error);
    return null;
  }
}

/** Where the match is on the page, as a share of the page's height from the top, or null when it isn't on the page showing. */
function matchPosition() {
  const result = searchResults[searchIndex];
  return result ? pagePosition(result.cfi) : null;
}

/** Where the text at cfi is on the page, as a share of the page's height from the top, or null when it isn't on the page showing. */
function pagePosition(cfi) {
  const viewer = viewerEl.getBoundingClientRect();
  if (!rendition || viewer.height <= 0) return null;
  for (const contents of rendition.getContents()) {
    const range = cfiRange(contents, cfi);
    const frame = contents.window?.frameElement?.getBoundingClientRect();
    if (!range || !frame) continue;
    const rect = range.getBoundingClientRect();
    const left = frame.left + rect.left;
    if (left + Math.max(rect.width, 1) > viewer.left && left < viewer.right) {
      return (frame.top + (rect.top + rect.bottom) / 2 - viewer.top) / viewer.height;
    }
  }
  return null;
}

/** Moves the bar to the top of the page when the match is low on it, where the bar would cover it. */
function placeSearchBar() {
  const position = matchPosition();
  if (position != null) searchBarEl.classList.toggle('top', position > LOW_MATCH);
}

function updateSearchBar() {
  if (searchQuery === null) return;
  // The words kept apart, so quotes around right-to-left ones face the right way.
  const position = document.createElement('span');
  position.append(`${searchIndex + 1} of ${searchResults.length} · “`, Object.assign(document.createElement('bdi'), { textContent: searchQuery }), '”');
  searchPositionEl.replaceChildren(position);
  searchPreviousEl.disabled = searchIndex <= 0;
  searchNextEl.disabled = searchIndex >= searchResults.length - 1;
  searchBarEl.classList.remove('hidden');
}

function clearResult() {
  searchIndex = -1;
  searchBarEl.classList.add('hidden');
  searchBarEl.classList.remove('top');
  rendition?.getContents().forEach(markContents);
}

/** Back to the contents list, and to reading without a mark on the page. */
function endSearch() {
  resetSearch();
  showContents();
}

function resetSearch() {
  searchRun++;
  clearResult();
  searchQuery = null;
  searchResults = [];
  searchListEl.innerHTML = '';
  searchFieldEl.value = '';
  searchClearEl.classList.add('hidden');
}

// --- The end of the book -------------------------------------------------------

function wireBookEndEvents() {
  document.getElementById('bookEndRestart')?.addEventListener('click', () => goToBeginning());
  document.getElementById('bookEndLibrary')?.addEventListener('click', () => openPanel('library'));
  document.getElementById('bookEndDelete')?.addEventListener('click', () => currentRecord && confirmDelete(currentRecord.id));
  document.getElementById('bookEndClose')?.addEventListener('click', () => showEnd(false));
}

function showEnd(visible) {
  if (bookEndEl.classList.contains('hidden') !== visible) return;
  if (visible) bookEndTitleEl.textContent = currentRecord?.title || currentRecord?.name || '';
  bookEndEl.classList.toggle('hidden', !visible);
}

function goToBeginning() {
  const first = book?.spine?.first();
  if (!rendition || !first) return;
  clearLinkHistory();
  showEnd(false);
  keptPlace = null;
  rendition.display(first.href).catch((error) => log.warn('Failed to go to the beginning:', error));
}

/** Asks first; a deleted book is gone, with where it was read to. */
function confirmDelete(id) {
  return new Promise((resolve) => {
    db.get('books', id).then((record) => {
      if (!record) return resolve();
      document.getElementById('deleteDialogTitle').textContent = record.title || record.name;
      const confirm = document.getElementById('deleteConfirm');
      const onConfirm = async () => {
        deleteDialogEl.close();
        await deleteBook(id);
      };
      confirm.addEventListener('click', onConfirm, { once: true });
      deleteDialogEl.addEventListener('close', () => {
        confirm.removeEventListener('click', onConfirm);
        resolve();
      }, { once: true });
      deleteDialogEl.showModal();
    });
  });
}

async function deleteBook(id) {
  await db.delete('books', id);
  if (localStorage.getItem('lastOpenedBookId') === id) localStorage.removeItem('lastOpenedBookId');
  const wasOpen = currentRecord?.id === id;
  if (wasOpen) clearViewer();
  await renderLibrary();
  await refreshEmptyState();
  // Deleted from the end screen: on to the next book. An empty library has its own screen.
  if (wasOpen && panelEl.classList.contains('hidden') && await db.count('books')) openPanel('library');
}

// --- Links -------------------------------------------------------------------

/**
 * A link tapped in the book. Links out of it open in a new tab, never inside the reader;
 * footnotes open over the page; other links turn to where they point, and Back returns.
 */
async function handleBookLink(link) {
  const href = link.getAttribute('href');
  if (!href || !rendition) return;
  if (/^(https?|mailto):/i.test(href)) {
    window.open(href, '_blank', 'noopener,noreferrer');
    return;
  }
  const target = bookPath(link, href);
  if (!target) return;
  if (isNoteReference(link) && await showFootnote(link, target)) return;
  followLink(target);
}

/** Where a link points, relative to the book's package as epub.js has it; null if out of the book. */
function bookPath(link, href) {
  try {
    const base = documentBase(link.ownerDocument);
    const url = new URL(href, base);
    if (url.origin !== base.origin) return null;
    return book.path.relative(decodeURIComponent(url.pathname)) + url.hash;
  } catch (error) {
    log.debug('Could not follow a link:', href, error);
    return null;
  }
}

/** The page's own file in the book: epub.js names it in the page's <base>. */
function documentBase(doc) {
  return new URL(doc.querySelector('base')?.getAttribute('href') || '/', 'https://book.invalid/');
}

function isNoteReference(link) {
  const type = link.getAttributeNS(OPS_NAMESPACE, 'type') || link.getAttribute('epub:type') || '';
  return type.split(/\s+/).includes('noteref');
}

/** Shows the note a reference points to, if it can be found; reports whether it was. */
async function showFootnote(link, target) {
  const [path, id] = target.split('#');
  if (!id) return false;
  const read = (doc) => {
    let note = doc.getElementById(decodeURIComponent(id));
    // An anchor marking the note's place: its text is around it.
    if (note && (note.localName === 'a' || !note.textContent.trim())) note = note.parentElement;
    return note ? collapse(note.textContent).trim().slice(0, MAX_NOTE_LENGTH) : '';
  };
  let text = '';
  try {
    const here = book.path.relative(decodeURIComponent(documentBase(link.ownerDocument).pathname));
    const section = path && path !== here ? book.spine.get(path) : null;
    text = section ? await withSectionDocument(book, section, read) : read(link.ownerDocument);
  } catch (error) {
    log.debug('Could not read a footnote:', error);
  }
  if (!text) return false;
  document.getElementById('noteText').textContent = text;
  noteDialogEl.showModal();
  return true;
}

/** Turns to where a link points, remembering where it was followed from. */
function followLink(target) {
  const here = rendition.currentLocation?.()?.start;
  const last = linkHistory[linkHistory.length - 1];
  const targetSection = book.spine.get(target.split('#')[0]);
  if (last && targetSection && book.section(last)?.index === targetSection.index) {
    // Following a link back to where the last one was followed from, as notes do.
    linkHistory.pop();
    ignoredPops++;
    history.back();
  } else if (here?.cfi) {
    linkHistory.push(here.cfi);
    if (linkHistory.length > MAX_LINK_HISTORY) linkHistory.shift();
    history.pushState({ squidreadLink: true }, '');
  }
  showEnd(false);
  keptPlace = null;
  rendition.display(target).catch(async (error) => {
    log.debug('Direct link navigation failed, trying spine match:', target, error);
    const targetSpine = findSpineItemByHref(target);
    if (targetSpine) await rendition.display(targetSpine.href);
  });
}

/** Forgets the trail of links; Back leaves the reader again, as before it was followed. */
function clearLinkHistory() {
  if (!linkHistory.length) return;
  const steps = linkHistory.length;
  linkHistory.length = 0;
  ignoredPops++;
  history.go(-steps);
}

// --- Page layout ---------------------------------------------------------------

const PAGE_BREAKS = new Set(['page', 'left', 'right', 'recto', 'verso']);
// Where the book's style sheets are read, apart from the reader's own.
const cssDocument = document.implementation.createHTMLDocument('');

/**
 * Books ask for a new page before chapters and pictures with page breaks, but epub.js lays the
 * book out in columns, where a page break means nothing. The elements they apply to get column
 * breaks, which start a new page there. Done to each section's own document before epub.js
 * lays it out, so a page shown from a saved place is the page it was.
 */
async function keepPageBreaks(opened, doc, section, cache) {
  const breaks = [];
  for (const node of doc.querySelectorAll('link[href], style')) {
    if (node.localName === 'style') {
      breaks.push(...pageBreakRules(node.textContent));
    } else if (/(^|\s)stylesheet(\s|$)/i.test(node.getAttribute('rel') || '')) {
      const path = new URL(node.getAttribute('href'), new URL(section.url, 'https://book.invalid/')).pathname;
      if (!cache.has(path)) cache.set(path, opened.load(path).then(pageBreakRules, () => []));
      breaks.push(...await cache.get(path));
    }
  }
  const fix = (element, rule) => {
    if (rule.before) element.style.breakBefore = 'column';
    if (rule.after) element.style.breakAfter = 'column';
  };
  for (const rule of breaks) {
    let elements = [];
    // Selectors the reader's own documents can't read, such as those with a namespace, stay as they are.
    try {
      elements = doc.querySelectorAll(rule.selector);
    } catch (error) {}
    elements.forEach((element) => element.style && fix(element, rule));
  }
  doc.querySelectorAll('[style]').forEach((element) => {
    if (!element.style) return;
    fix(element, { before: PAGE_BREAKS.has(element.style.breakBefore), after: PAGE_BREAKS.has(element.style.breakAfter) });
  });
}

/** The rules of a style sheet that ask for a page break, with what they select. */
function pageBreakRules(text) {
  if (typeof text !== 'string') return [];
  const style = cssDocument.createElement('style');
  style.textContent = text;
  cssDocument.head.appendChild(style);
  const rules = [];
  const walk = (list) => {
    for (const rule of list) {
      if (rule.style && rule.selectorText) {
        const before = PAGE_BREAKS.has(rule.style.breakBefore);
        const after = PAGE_BREAKS.has(rule.style.breakAfter);
        if (before || after) rules.push({ selector: rule.selectorText, before, after });
      }
      if (rule.cssRules) walk(rule.cssRules);
    }
  };
  try {
    walk(style.sheet?.cssRules || []);
  } finally {
    style.remove();
  }
  return rules;
}

function isEditableTarget(target) {
  if (!isDomElement(target)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isDomElement(target) {
  return !!target && target.nodeType === 1;
}

function findSpineItemByHref(href) {
  const baseHref = (href || '').split('#')[0];
  if (!baseHref || !book?.spine) return null;

  for (let i = 0; i < book.spine.length; i++) {
    const spineItem = book.spine.get(i);
    if (spineItem?.href && spineItem.href.includes(baseHref)) {
      return spineItem;
    }
  }

  return null;
}

function getDroppedEpubFile(dataTransfer) {
  const files = dataTransfer?.files;
  if (!files?.length) return null;

  for (const file of files) {
    const isEpubMime = file.type === 'application/epub+zip';
    const isEpubExtension = /\.epub$/i.test(file.name || '');
    if (isEpubMime || isEpubExtension) {
      return file;
    }
  }

  return null;
}

async function handleLocalFile(file) {
  // Read whole into memory; a file this size isn't a book, and could stall the tab.
  if (file.size > MAX_BOOK_BYTES) {
    showToast('File too large');
    return;
  }
  if (isProcessing) {
    log.debug('Ignoring selection while processing');
    return;
  }
  isProcessing = true;
  try {
    startProgress(`Reading ${file.name}`);
    log.info('File selected:', { name: file.name, size: file.size });
    const arrayBuffer = await readFileWithProgress(file, (percent) => {
      setProgress(percent, `Reading file: ${percent}%`);
      maybeLogProgress('file', percent);
    });
    setProgress(null, 'Saving to library...');
    log.info('File read complete; saving to IndexedDB');
    await saveBook(file.name, new Blob([arrayBuffer], { type: 'application/epub+zip' }));
  } catch (error) {
    log.error('File handling failed:', error);
    endProgress();
    showToast('Failed to read file');
  } finally {
    isProcessing = false;
  }
}

async function saveBook(name, blob) {
  log.info('Persisting book:', { name, size: blob.size });
  
  // Create a hash of the blob to use as a stable ID
  const hashBuffer = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  const id = hashHex.substring(0, 12); // Use first 12 chars as ID
  
  // Check if book already exists
  const existingRecord = await db.get('books', id);
  if (existingRecord) {
    // Book already exists, just update createdAt and load it
    log.info('Book already exists, switching to it:', id);
    existingRecord.createdAt = Date.now();
    await db.put('books', existingRecord);
    await renderLibrary();
    await loadBook(id);
    showToast(`Book already in library`);
    endProgress();
    return;
  }
  
  // New book - extract title, author and cover from EPUB
  let title = name.replace(/\.epub$/i, '');
  let coverDataUrl = null;
  let author = '';

  try {
    await ensureEpubDepsLoaded();
    const tempBook = await ePub(blob).opened;
    title = tempBook.packaging?.metadata?.title || title;
    author = await readAuthor(blob);
    
    // Try to get cover image and convert to data URL
    if (tempBook.cover) {
      try {
        const blobUrl = await tempBook.resources.createUrl(tempBook.cover);
        // Fetch the blob and convert to data URL for persistence
        const response = await fetch(blobUrl);
        const coverBlob = await response.blob();
        coverDataUrl = await blobToDataUrl(coverBlob);
        log.debug('Cover extracted and converted to data URL');
      } catch (error) {
        log.warn('Could not extract cover image:', error);
      }
    }
  } catch (error) {
    log.warn('Could not extract metadata from EPUB:', error);
  }
  
  const record = {
    id,
    name,
    title,
    author,
    blob,
    coverDataUrl,
    createdAt: Date.now(),
    lastOpened: Date.now(),
    lastLocation: null,
  };
  
  await db.put('books', record);
  log.debug('Book saved in IndexedDB:', { id });
  await renderLibrary();
  await loadBook(id);
  showToast(`Added to library: ${name}`);
  endProgress();
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

let libraryQuery = '';
let authorsCompleted = false;

/**
 * The books, most recently opened first, then the "Add EPUB" tile. While there are no books, a
 * tile suggesting free books comes before it, and a note follows across the whole row. With a
 * query, only the books whose title or author has every word of it, or a note that none do.
 */
async function renderLibrary() {
  log.debug('Rendering library');
  const books = await db.getAll('books');
  books.sort((a, b) => (b.lastOpened || b.createdAt) - (a.lastOpened || a.createdAt));
  librarySearchRowEl?.classList.toggle('hidden', !books.length);

  const words = fold(libraryQuery).split(' ').filter(Boolean);
  const filtering = words.length > 0 && books.length > 0;
  const shown = filtering
    ? books.filter((record) => {
      const text = fold(`${record.title || record.name} ${record.author || ''}`);
      return words.every((word) => text.includes(word));
    })
    : books;

  // Clear library but keep the Add EPUB button (and its wired handlers)
  const addButton = libraryEl.querySelector('.libraryAddItem');
  libraryEl.innerHTML = '';

  for (const record of shown) {
    const li = document.createElement('li');
    li.className = 'libraryItem';
    li.classList.toggle('current', record.id === currentRecord?.id);

    const hasCoverData = record.coverDataUrl && record.coverDataUrl.startsWith('data:');

    // Create portrait button with cover image
    const portraitBtn = document.createElement('button');
    portraitBtn.className = 'portraitBtn';
    portraitBtn.dataset.action = 'open';
    portraitBtn.dataset.id = record.id;
    portraitBtn.title = `Open "${record.title || record.name}"`;

    // Cover image container
    const coverContainer = document.createElement('div');
    coverContainer.className = 'coverContainer';

    if (hasCoverData) {
      coverContainer.className = 'coverContainer hasCover';
      const coverImage = document.createElement('img');
      coverImage.className = 'coverImage';
      coverImage.src = record.coverDataUrl;
      coverImage.alt = '';
      coverContainer.appendChild(coverImage);
    } else {
      if (record.coverDataUrl && record.coverDataUrl.startsWith('blob:')) {
        record.coverDataUrl = null;
        await db.put('books', record);
      }
      // Placeholder for no cover
      coverContainer.className = 'coverContainer noCover';
    }

    portraitBtn.appendChild(coverContainer);

    // Book title
    const titleEl = document.createElement('div');
    titleEl.className = 'bookTitle';
    titleEl.dir = 'auto';
    titleEl.textContent = record.title || record.name;
    portraitBtn.appendChild(titleEl);

    li.appendChild(portraitBtn);

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'deleteBtn';
    deleteBtn.textContent = '✕';
    deleteBtn.dataset.action = 'delete';
    deleteBtn.dataset.id = record.id;
    deleteBtn.title = 'Delete book';
    li.appendChild(deleteBtn);

    libraryEl.appendChild(li);
  }

  if (filtering) {
    if (!shown.length) libraryEl.appendChild(libraryHint(`No books match “${libraryQuery.trim()}”`));
    return;
  }
  if (!books.length) libraryEl.appendChild(librarySuggestion());
  if (addButton) libraryEl.appendChild(addButton);
  if (!books.length) libraryEl.appendChild(libraryHint('No books yet. Tap “+ Add EPUB”, or drop an EPUB file here.'));
}

function libraryHint(text) {
  const li = document.createElement('li');
  li.className = 'libraryHint';
  li.textContent = text;
  return li;
}

/** Next to the "Add EPUB" tile while the library is empty: where free books can be found. */
function librarySuggestion() {
  const li = document.createElement('li');
  li.className = 'librarySuggestion';
  const heading = document.createElement('h3');
  heading.textContent = 'Free books';
  const text = document.createElement('p');
  text.textContent = 'Project Gutenberg has thousands of free EPUBs. For example:';
  li.append(heading, text, externalLink('Dracula', GUTENBERG_EXAMPLE_URL), externalLink('More books', GUTENBERG_URL));
  return li;
}

function externalLink(label, href) {
  const link = document.createElement('a');
  link.className = 'linkButton';
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.textContent = label;
  return link;
}

function setLibraryQuery(value) {
  if (librarySearchFieldEl.value !== value) librarySearchFieldEl.value = value;
  librarySearchClearEl.classList.toggle('hidden', !value);
  if (libraryQuery === value) return;
  libraryQuery = value;
  renderLibrary();
  libraryEl.scrollTop = 0;
}

/**
 * Reads the authors of books added before they were kept, the first time the library is
 * searched; until then nothing needs them.
 */
async function completeAuthors() {
  if (authorsCompleted) return;
  authorsCompleted = true;
  const missing = (await db.getAll('books')).filter((record) => typeof record.author !== 'string');
  if (!missing.length) return;
  try {
    await ensureEpubDepsLoaded();
  } catch (error) {
    log.warn('Could not load the EPUB reader to find authors:', error);
    return;
  }
  for (const record of missing) {
    record.author = await readAuthor(record.blob);
    await db.put('books', record);
  }
  if (libraryQuery.trim()) await renderLibrary();
}

/**
 * The authors named in the package document: its creators, less those whose role says they
 * are not the author (an editor or illustrator). Empty when there are none or the file can't
 * be read; books come from anywhere, so nothing here may throw.
 */
async function readAuthor(blob) {
  try {
    const zip = await window.JSZip.loadAsync(blob);
    const container = await readSmall(zip, 'META-INF/container.xml');
    const parser = new DOMParser();
    const rootfile = container && parser.parseFromString(container, 'application/xml').getElementsByTagNameNS('*', 'rootfile')[0];
    const packagePath = rootfile?.getAttribute('full-path');
    const document = packagePath && await readSmall(zip, packagePath);
    if (!document) return '';
    const creators = [...parser.parseFromString(document, 'application/xml').getElementsByTagNameNS(DC_NAMESPACE, 'creator')]
      .filter((creator) => {
        const role = [...creator.attributes].find((attribute) => attribute.localName === 'role')?.value;
        return !role || role === 'aut';
      })
      .map((creator) => cleanTitle(creator.textContent))
      .filter(Boolean);
    return cleanTitle(creators.join(', '));
  } catch (error) {
    log.debug('Could not read the author:', error);
    return '';
  }
}

/** A file in the book, when it is small enough to be what it claims; nothing otherwise. */
async function readSmall(zip, path) {
  const entry = zip.file(path);
  // The size the zip's directory gives; JSZip refuses a file that turns out bigger than that.
  if (!entry || entry._data?.uncompressedSize > MAX_PACKAGE_BYTES) return null;
  return entry.async('string');
}

/**
 * A title fit to show: on one line, and not so long that it overflows. Titles come from files,
 * so they can be anything.
 */
function cleanTitle(title) {
  const clean = (title || '').replace(/[\p{Cc}\s]+/gu, ' ').trim();
  return clean.length > MAX_TITLE_LENGTH ? clean.slice(0, MAX_TITLE_LENGTH) : clean;
}

/** Lower case, without accents or vowel points, on one line. */
function fold(text) {
  return text.normalize('NFD').replace(MARKS, '').replace(/\s+/g, ' ').toLowerCase();
}

/** The contents list, flat, numbered as in the footer ("2.3"). */
function buildTocEntries(items) {
  const entries = [];
  const visit = (list, depth, parentNumber) => {
    // Deeper levels than any real book has are left out rather than recursed into.
    if (depth > MAX_TOC_DEPTH) return;
    let count = 0;
    for (const item of list) {
      let number = '';
      if (item.href) {
        count++;
        number = parentNumber ? `${parentNumber}.${count}` : `${count}`;
      }
      entries.push({
        title: cleanTitle(item.label || item.title) || cleanTitle(item.href) || 'Untitled',
        href: item.href || '',
        path: (item.href || '').split('#')[0],
        depth,
        number,
      });
      if (item.subitems?.length) visit(item.subitems, depth + 1, number || parentNumber);
    }
  };
  visit(items, 0, '');
  return entries;
}

/**
 * Stands in for a missing table of contents: one entry per section of the reading order, in
 * order, numbered until their headings are found (see findSectionTitles).
 */
function buildSections() {
  const entries = [];
  book?.spine?.each((section) => {
    if (!section.linear) return;
    const number = `${entries.length + 1}`;
    entries.push({ title: `Section ${number}`, href: section.href, path: section.href, depth: 0, number, section });
  });
  return entries;
}

/**
 * Names the sections of a book without a table of contents after the first heading in each,
 * in the background, so the book opens as fast as any other.
 */
async function findSectionTitles(opened) {
  for (const entry of tocEntries) {
    if (book !== opened || !entry.section) return;
    try {
      const heading = await withSectionDocument(opened, entry.section, (doc) => doc.querySelector('h1, h2, h3, h4, h5, h6')?.textContent);
      const title = cleanTitle(heading);
      if (title) entry.title = title;
    } catch (error) {
      log.debug('Could not read a section heading:', error);
    }
  }
  if (book !== opened) return;
  renderToc();
  if (rendition?.location) updateChapterInfo(rendition.location);
}

/**
 * Runs read on a section's own document, loaded apart from the page showing it, and lets the
 * document go after unless it was already loaded.
 */
async function withSectionDocument(opened, section, read) {
  const loaded = !!section.contents;
  const contents = await section.load(opened.load.bind(opened));
  try {
    return read(contents.ownerDocument);
  } finally {
    if (!loaded) section.unload();
  }
}

/** The contents list, or a note saying why there is none, or what stands in for it. */
function renderToc() {
  if (!tocListEl) return;
  tocListEl.innerHTML = '';
  const note = !book
    ? 'Open a book to see its table of contents.'
    : !tocEntries.length
      ? 'This book has no table of contents.'
      : showsSections
        ? 'This book has no table of contents. Its sections, in order:'
        : null;
  if (note) {
    const li = document.createElement('li');
    li.className = 'meta';
    li.textContent = note;
    tocListEl.appendChild(li);
  }

  tocEntries.forEach((entry, index) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.className = 'tocItem';
    btn.dataset.href = entry.href;
    btn.dataset.index = index;
    btn.textContent = entry.title;
    // Deeper entries keep this indent, so they never squeeze to nothing.
    btn.style.paddingInlineStart = `${16 + Math.min(entry.depth, MAX_INDENT_DEPTH) * 16}px`;
    btn.disabled = !entry.href;
    li.appendChild(btn);
    tocListEl.appendChild(li);
  });
}

/** The first entry pointing at the section, as the footer names it. */
function tocEntryFor(sectionHref) {
  if (!sectionHref) return null;
  // Contents name files from where the contents file is, the spine from the package; the same
  // file can be named with more of its path in one than in the other.
  const samePath = (path) => path === sectionHref || sectionHref.endsWith(`/${path}`) || path.endsWith(`/${sectionHref}`);
  return tocEntries.find((entry) => entry.path && samePath(entry.path)) || null;
}

// A block holding one picture and no text is a page of a comic or a picture
// book, often in a box of fixed pixels (Kindle comics use 880 by 1280).
// Taller than the page, it spills onto blank pages after it; keep it to one.
function fitImagePages(doc) {
  if (!doc.getElementById('squidread-image-pages')) {
    const style = doc.createElement('style');
    style.id = 'squidread-image-pages';
    style.textContent = `
      .squidread-image-page {
        max-width: 100% !important;
        max-height: 90vh !important;
        overflow: hidden !important;
        break-inside: avoid;
      }
    `;
    doc.head.appendChild(style);
  }
  for (const el of doc.body.children) {
    if (el.textContent.trim()) continue;
    const sources = new Set(
      [...el.querySelectorAll('img, image')].map(
        (img) => img.getAttribute('src') || img.getAttribute('href') || img.getAttribute('xlink:href'),
      ),
    );
    if (sources.size === 1) el.classList.add('squidread-image-page');
  }
}

// Cache for injected iframes to avoid repeated DOM checks
const injectedIframes = new WeakSet();

function injectContentCSS() {
  // Minimal CSS - only prevent images from overflowing
  const iframes = document.querySelectorAll('.viewer iframe');
  iframes.forEach(iframe => {
    // Skip if already processed to reduce overhead
    if (injectedIframes.has(iframe)) return;
    
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      
      // Inject once per iframe document
      if (!doc.querySelector('#squidread-content-styles')) {
        const style = doc.createElement('style');
        style.id = 'squidread-content-styles';
        // epub.js caps img and svg at the page size in pixels. A percentage
        // cap would shrink them to nothing in a box that has no width of its
        // own, like the absolutely positioned pages of Kindle comics.
        style.textContent = `
          img, svg, video, canvas, iframe {
            height: auto !important;
          }
          video, canvas, iframe {
            max-width: 100% !important;
          }
          /* Taps turn pages; text selection swallows them */
          html, body {
            -webkit-user-select: none !important;
            user-select: none !important;
            -webkit-touch-callout: none !important;
            -webkit-tap-highlight-color: transparent;
          }
        `;
        doc.head.appendChild(style);
      }
      
      // Mark as processed
      injectedIframes.add(iframe);

      // Click/keydown handlers, links among them, are attached via rendition content hooks.
    } catch (e) {
      log.debug('Could not inject CSS into iframe:', e);
    }
  });
}

async function persistCurrentLocation() {
  try {
    if (!rendition || !currentRecord) return;
    const location = rendition.currentLocation?.();
    const cfi = location?.start?.cfi;
    if (!cfi) return;
    currentRecord.lastLocation = cfi;
    await db.put('books', currentRecord);
    log.debug('Persisted current location');
  } catch (error) {
    log.debug('Failed to persist current location:', error);
  }
}

function resizeRendition() {
  if (!rendition || !viewerEl) return;
  const rect = viewerEl.getBoundingClientRect();
  const width = Math.min(window.innerWidth, Math.floor(rect.width));
  const height = Math.min(window.innerHeight, Math.floor(rect.height));
  if (width > 0 && height > 0) {
    fixedViewerHeight = height;
    rendition.resize(width, height);
  }
}

function queueViewerRedraw() {
  // Debounce resize-driven redraws to avoid excessive layout work.
  if (resizeTimer) clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    resizeRendition();
    lockIframeHeight();
    resizeTimer = null;
  }, 150);
}

function lockIframeHeight() {
  if (!viewerEl || !fixedViewerHeight) return;
  const height = Math.min(window.innerHeight, fixedViewerHeight);
  const iframes = document.querySelectorAll('.viewer iframe');
  iframes.forEach((iframe) => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow.document;
      if (!doc) return;
      const container = doc.querySelector('.epub-container');
      const view = doc.querySelector('.epub-view');
      if (!container && !view) return;
      iframe.style.height = `${height}px`;
      iframe.style.minHeight = `${height}px`;
      if (container) {
        container.style.height = `${height}px`;
        container.style.minHeight = `${height}px`;
      }
      if (view) {
        view.style.height = `${height}px`;
        view.style.minHeight = `${height}px`;
      }
    } catch (e) {
      log.debug('Could not lock iframe height:', e);
    }
  });
}

async function loadBook(id) {
  log.info('Opening book:', id);
  const record = await db.get('books', id);
  if (!record) return;

  closePanel();
  clearViewer();
  setViewerEmptyState(false);
  currentRecord = record;
  localStorage.setItem('lastOpenedBookId', id);
  
  // Update last opened timestamp
  currentRecord.lastOpened = Date.now();
  await db.put('books', currentRecord);
  
  // Re-render library to update order
  await renderLibrary();

  // Update menu title with book title
  if (menuTitleEl) {
    menuTitleEl.textContent = record.title || record.name || 'Squidread';
  }

  try {
    await ensureEpubDepsLoaded();
    log.info('Creating ePub instance from blob');
    book = ePub(record.blob);
    log.info('Waiting for book to open');
    await book.opened;
    log.info('Book opened successfully');
  } catch (error) {
    log.error('Failed to open book:', error);
    showToast('Failed to open book');
    throw error;
  }
  
  // Right to left as the book's page progression says, or by its language when it says nothing.
  const metadata = book.packaging?.metadata || {};
  const pageDir = metadata.direction;
  isRTL = pageDir === 'rtl' || (pageDir !== 'ltr' && RTL_LANGUAGES.has(String(metadata.language || '').toLowerCase().split('-')[0]));
  // epub.js lays out pages from this too.
  if (isRTL) metadata.direction = 'rtl';
  
  // Set TOC direction
  tocListEl.dir = isRTL ? 'rtl' : 'ltr';
  searchListEl.dir = tocListEl.dir;

  // The contents first, so the footer can name the chapter of the first page shown. epub.js
  // never settles the contents of a book whose contents file is broken; its sections stand in.
  try {
    const nav = await Promise.race([book.loaded.navigation, wait(NAVIGATION_WAIT_MS)]);
    tocEntries = buildTocEntries(nav?.toc || []);
  } catch (error) {
    log.warn('Failed to load TOC:', error);
    tocEntries = [];
  }
  showsSections = !tocEntries.length;
  if (showsSections) tocEntries = buildSections();
  // Nor the book's list of printed pages, which it needs to report where each page is.
  book.pageList ??= { pageFromCfi: () => -1, destroy() {} };
  renderToc();
  searchRowEl.classList.remove('hidden');

  const opened = book;
  const styleSheets = new Map();
  opened.spine.hooks.content.register((doc, section) => keepPageBreaks(opened, doc, section, styleSheets).catch((error) => {
    log.debug('Could not keep page breaks:', error);
  }));
  
  rendition = book.renderTo('viewer', {
    width: '100%',
    height: '100%',
    spread: 'none',
    // Books' own scripts stay off: their pages share the reader's origin, so a script could
    // read every stored book, change the reader, or replace its offline copy.
    allowScriptedContent: false,
  });

  rendition.hooks.content.register((contents) => {
    try {
      const doc = contents?.document;
      if (!doc?.body) return;

      if (!doc.body.dataset.squidreadContentHooksBound) {
        doc.body.dataset.squidreadContentHooksBound = '1';
        doc.addEventListener('click', handleRenditionContentPointer, true);
        doc.addEventListener('keydown', handleReaderKeydown);
        doc.addEventListener('touchstart', handleTouchStart, { passive: true });
        doc.addEventListener('touchend', handleTouchEnd);
      }
      fitImagePages(doc);
      markContents(contents);
    } catch (error) {
      log.debug('Failed to bind rendition content hooks:', error);
    }
  });

  rendition.on('relocated', async (location) => {
    log.debug('Relocated:', location?.start?.cfi);
    isTurningPage = false;
    lockIframeHeight();
    injectContentCSS();
    updatePosition(location);
    // Moved away from the end, by the contents or a new layout: the page itself shows.
    if (!location?.atEnd) showEnd(false);
    if (!searchBarEl.classList.contains('hidden')) placeSearchBar();
    currentRecord.lastLocation = location?.start?.cfi || null;
    await db.put('books', currentRecord);
  });

  try {
    // Use paginated (page-by-page) flow, not scrolled
    rendition.flow('paginated');
    
    await rendition.display(record.lastLocation || undefined);
    
    // Apply current font size setting and theme colours
    applyFontSize();
    applyBookTheme();
    
    // Wait a bit for the iframe to be created
    await wait(50);
    
    // Single batch of layout operations
    resizeRendition();
    
    // Use Promise-based delays instead of multiple setTimeout for efficiency
    await wait(0);
    resizeRendition();
    lockIframeHeight();
    
    await wait(150);
    injectContentCSS();
    
    log.info('Displayed rendition');
    
    // Restore saved font size preference
    const savedFontSize = localStorage.getItem('squidreadFontSize');
    if (savedFontSize) {
      currentFontSize = parseFloat(savedFontSize);
      applyFontSize();
    }
    
    // Final CSS injection
    await wait(150);
    injectContentCSS();
  } catch (error) {
    log.error('Failed to display EPUB:', error);
  }

  if (showsSections) findSectionTitles(book);

  book.ready.then(async () => {
    try {
      await book.locations.generate(1024);
      locationsReady = true;
      log.debug('Locations generated');
    } catch (error) {
      log.warn('Location generation failed', error);
    }
  });
}

function togglePanel() {
  panelEl.classList.toggle('hidden');
  
  // If opening panel and no book is loaded, switch to Library tab
  if (!panelEl.classList.contains('hidden') && !currentRecord) {
    switchPanelSection('library');
  }
}

function closePanel() {
  panelEl.classList.add('hidden');
}


function adjustFontSize(delta) {
  setFontSize(currentFontSize + delta);
}

function resetFontSize() {
  setFontSize(1.0);
}

function setFontSize(value) {
  // Round to one decimal so repeated steps don't drift.
  const size = Math.max(0.5, Math.min(2.0, Math.round(value * 10) / 10));
  if (size === currentFontSize) return;
  // epub.js keeps the page's number in the chapter, not its words, so a bigger size would show
  // text from before them. The words are kept for further changes until the page is turned.
  keptPlace ??= rendition?.currentLocation?.()?.start?.cfi || null;
  currentFontSize = size;
  applyFontSize();
  localStorage.setItem('squidreadFontSize', currentFontSize);
  restorePlace(KEEP_PLACE_TRIES);
}

/**
 * Turns to the page the kept words are now on, once the new layout has settled; epub.js moves
 * the page again as it adjusts, so it looks a few times.
 */
function restorePlace(tries) {
  clearTimeout(placeTimer);
  placeTimer = setTimeout(async () => {
    if (!keptPlace || !rendition) return;
    if (pagePosition(keptPlace) === null) {
      await rendition.display(keptPlace).catch((error) => log.debug('Could not keep the place:', error));
    }
    if (tries > 1) restorePlace(tries - 1);
  }, KEEP_PLACE_MS);
}

function applyFontSize() {
  const fontSizeValueEl = document.getElementById('fontSizeValue');
  if (fontSizeValueEl) fontSizeValueEl.textContent = `${Math.round(currentFontSize * 100)}%`;
  if (!rendition) return;
  
  // Apply font size to the book's body element
  rendition.themes.fontSize(`${currentFontSize}em`);
  log.debug(`Font size adjusted to ${currentFontSize}em`);
}

function switchPanelSection(section) {
  // Use CSS class toggling to reduce reflows
  const navBtnId = `nav${section.charAt(0).toUpperCase() + section.slice(1)}`;
  const panelId = `${section}Section`;
  const navBtn = document.getElementById(navBtnId);
  const panel = document.getElementById(panelId);
  
  if (!navBtn || !panel) return;
  
  // Remove active from all, toggle on current (batch updates)
  document.querySelectorAll('.navBtn').forEach(btn => {
    btn.classList.toggle('active', btn === navBtn);
  });
  document.querySelectorAll('.panelSection').forEach(sec => {
    sec.classList.toggle('active', sec === panel);
  });
  
  // Scroll the active TOC item, or search result, into view if switching to contents
  if (section === 'contents') {
    setTimeout(() => {
      const activeItem = searchQuery !== null ? searchListEl.querySelector('.searchItem.active') : tocListEl?.querySelector('.tocItem.active');
      if (activeItem) {
        activeItem.scrollIntoView({ block: 'nearest' });
      }
    }, 0);
  }
}

function clearViewer() {
  setViewerEmptyState(true);
  resetSearch();
  showEnd(false);
  clearLinkHistory();
  keptPlace = null;
  if (rendition) {
    rendition.destroy();
    rendition = null;
  }
  if (book) {
    book.destroy();
    book = null;
  }
  log.info('Cleared viewer');
  currentRecord = null;
  viewerEl.innerHTML = '';
  progressPercentEl.textContent = '-';
  chapterInfoEl.textContent = '-';
  if (chapterNumberEl) chapterNumberEl.textContent = '-';
  if (menuTitleEl) {
    menuTitleEl.textContent = 'Squidread';
  }
  tocEntries = [];
  showsSections = false;
  searchRowEl.classList.add('hidden');
  renderToc();
  refreshEmptyState();
}

function setViewerEmptyState(visible) {
  if (!viewerEmptyStateEl) return;
  viewerEmptyStateEl.classList.toggle('hidden', !visible);
}

/**
 * What the reader shows without a book: with an empty library, what it is for and where books
 * come from; otherwise a way to the library.
 */
async function refreshEmptyState() {
  const empty = !(await db.count('books'));
  viewerEmptyTitleEl.textContent = empty ? 'This is where you read' : 'No book selected';
  readerIntroEl.classList.toggle('hidden', !empty);
  selectBookBtn.classList.toggle('hidden', empty);
  // Only while the tap zones are as they come: then it's true.
  const defaults = getDefaultZoneMap();
  readerIntroZonesEl.classList.toggle('hidden', Object.keys(defaults).some((key) => zoneActionMap[key] !== defaults[key]));
}

function openPanel(section) {
  if (panelEl.classList.contains('hidden')) {
    togglePanel();
  }
  if (section) switchPanelSection(section);
}

function cyclePanelSection(direction) {
  const sections = ['styles', 'contents', 'library', 'settings'];
  const current = getActivePanelSection();
  const currentIndex = Math.max(0, sections.indexOf(current));
  const nextIndex = (currentIndex + direction + sections.length) % sections.length;
  switchPanelSection(sections[nextIndex]);
}

function handleReaderKeydown(event) {
  if (event.defaultPrevented) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  // A dialog handles its own keys; Escape closes it.
  if (document.querySelector('dialog[open]')) return;

  // Escape closes what is open, the topmost first, and otherwise opens the menu.
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!panelEl.classList.contains('hidden')) {
      closePanel();
    } else if (!bookEndEl.classList.contains('hidden')) {
      showEnd(false);
    } else if (!searchBarEl.classList.contains('hidden')) {
      endSearch();
    } else {
      openPanel();
    }
    return;
  }

  if (isEditableTarget(event.target)) return;

  if (event.key === 'm' || event.key === 'M') {
    event.preventDefault();
    openPanel();
    return;
  }

  if (event.key === 'r' || event.key === 'R') {
    event.preventDefault();
    refreshServiceWorker();
    return;
  }

  if (event.key === 'Tab' && !panelEl.classList.contains('hidden')) {
    event.preventDefault();
    cyclePanelSection(event.shiftKey ? -1 : 1);
    return;
  }

  // The rest are for reading, not for the menu over it.
  if (!panelEl.classList.contains('hidden')) return;

  // Back to where the last link was followed from, as the browser's Back does.
  if (event.key === 'Backspace') {
    event.preventDefault();
    if (linkHistory.length) history.back();
    return;
  }

  // Page-turn buttons send these; next is next whichever way the book reads.
  if (event.key === 'PageDown') {
    event.preventDefault();
    goNextPage();
    return;
  }

  if (event.key === 'PageUp') {
    event.preventDefault();
    goPrevPage();
    return;
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault();
    if (isRTL) {
      goPrevPage();
    } else {
      goNextPage();
    }
    return;
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (isRTL) {
      goNextPage();
    } else {
      goPrevPage();
    }
  }
}

// Coordinates are relative to the top-level window viewport. Zones span the
// whole reader area above the footer, not only the (possibly narrower) viewer.
function handleViewerZoneClick(clientX, clientY) {
  const rect = readerEl?.getBoundingClientRect();
  if (!rect) return;
  const width = rect.width;
  const height = rect.height - (readerFooterEl?.offsetHeight || 0);
  if (width <= 0 || height <= 0) return;
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  log.debug('Viewer click at:', { x, y, width, height });
  if (x < 0 || y < 0 || x > width || y > height) return;
  // A swipe that some browsers also report as a tap has already turned the page.
  if (Date.now() - lastSwipeAt < SWIPE_CLICK_MS) return;
  // Without a book, any tap is for the library.
  if (!rendition) {
    openPanel('library');
    return;
  }

  // Zones are configured for left-to-right books; mirror the grid for RTL,
  // so each action keeps its meaning and moves to the opposite side.
  const tappedCol = getZoneIndex(x, width);
  const col = isRTL ? 2 - tappedCol : tappedCol;
  const row = getZoneIndex(y, height);
  const action = getZoneAction(row, col);
  log.debug('Viewer zone click:', { x, y, col, row, action });
  if (!action) return;

  if (action === 'menu') {
    openPanel();
    return;
  }
  if (action === 'next') {
    goNextPage();
    return;
  }
  if (action === 'prev') {
    goPrevPage();
  }
}

function goNextPage() {
  if (!rendition || isTurningPage) return;
  if (!bookEndEl.classList.contains('hidden')) return;
  // epub.js has no page after the last one; the end screen is there instead.
  if (rendition.location?.atEnd) {
    showEnd(true);
    return;
  }
  keptPlace = null;
  isTurningPage = true;
  rendition.next().catch(() => {
    isTurningPage = false;
  });
}

function goPrevPage() {
  // Back from the end screen to the last page, which is still in place under it.
  if (!bookEndEl.classList.contains('hidden')) {
    showEnd(false);
    return;
  }
  if (!rendition || isTurningPage) return;
  keptPlace = null;
  isTurningPage = true;
  rendition.prev().catch(() => {
    isTurningPage = false;
  });
}

function handleTouchStart(event) {
  const touch = event.touches.length === 1 ? event.touches[0] : null;
  // Screen coordinates, the same inside the book's frames as out of them.
  touchStart = touch && { x: touch.screenX, y: touch.screenY };
}

function handleTouchEnd(event) {
  const start = touchStart;
  touchStart = null;
  const touch = event.changedTouches[0];
  if (!start || !touch || !rendition || !panelEl.classList.contains('hidden')) return;
  const dx = touch.screenX - start.x;
  const dy = touch.screenY - start.y;
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) < 2 * Math.abs(dy)) return;
  lastSwipeAt = Date.now();
  // Swiping left brings in the page on the right: the next one in a left-to-right book.
  if ((dx < 0) !== isRTL) goNextPage(); else goPrevPage();
}

function handleRenditionContentPointer(event) {
  const target = event.target;
  if (!isDomElement(target)) return;

  event.preventDefault?.();
  event.stopImmediatePropagation?.();
  event.stopPropagation?.();

  // Caught on the way down, so epub.js's own link handling never sees the tap.
  const link = typeof target.closest === 'function' ? target.closest('a[href]') : null;
  if (link) {
    handleBookLink(link);
    return;
  }

  // Event coordinates are relative to the iframe, which epub.js makes wider
  // than the viewer and shifts per page. Map them to the top-level viewport.
  const frameRect = target.ownerDocument?.defaultView?.frameElement?.getBoundingClientRect?.();
  if (!frameRect) return;

  handleViewerZoneClick(frameRect.left + event.clientX, frameRect.top + event.clientY);
}

function getZoneIndex(value, max) {
  const ratio = Math.max(0, Math.min(0.999999, value / max));
  return Math.floor(ratio * 3);
}

function getZoneAction(row, col) {
  const key = `${row},${col}`;
  return zoneActionMap[key] || null;
}


function getActivePanelSection() {
  const activeSection = document.querySelector('.panelSection.active');
  if (!activeSection?.id) return 'styles';
  return activeSection.id.replace(/Section$/, '');
}

function updatePosition(location) {
  if (!location) return;
  
  // Update overall book progress
  let percentage = 0;
  const spineLength = book?.spine?.length || 0;
  if (locationsReady && book.locations.length() >= spineLength) {
    percentage = (location.start?.location / book.locations.total) * 100;
  } else if (spineLength) {
    // Locations count text, so a book of pictures has few or none of them.
    percentage = (location.start?.index / spineLength) * 100;
  }
  if (Number.isFinite(percentage)) {
    const rounded = Math.min(100, Math.max(0, percentage));
    progressPercentEl.textContent = `${rounded.toFixed(0)}%`;
  }
  
  // Update chapter info
  updateChapterInfo(location);
}

function updateClock() {
  // Only update if minute has changed to reduce DOM writes
  const now = Date.now();
  if (lastClockUpdate && now - lastClockUpdate < 60000) return;
  lastClockUpdate = now;
  const date = new Date();
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  if (clockEl) clockEl.textContent = `${hours}:${minutes}`;
}

function updateChapterInfo(location) {
  if (!chapterInfoEl || !location) return;
  
  try {
    // Get current section
    const section = book?.section(location.start.cfi);
    if (!section) {
      chapterInfoEl.textContent = '-';
      return;
    }
    
    const entry = tocEntryFor(section.href);
    
    // Update active TOC item
    if (tocListEl) {
      tocListEl.querySelectorAll('.tocItem.active').forEach((item) => item.classList.remove('active'));
      const index = entry ? tocEntries.indexOf(entry) : -1;
      tocListEl.querySelector(`.tocItem[data-index="${index}"]`)?.classList.add('active');
    }
    
    // Chapter name, then the page within the chapter (no prefix)
    const parts = [];
    if (entry) parts.push(entry.title);
    const displayed = rendition?.location?.start?.displayed;
    if (displayed) {
      parts.push(`${displayed.page}/${displayed.total}`);
    }
    
    chapterInfoEl.textContent = parts.filter(Boolean).join(' • ') || '•';
    
    // Chapter number of the top-level count in footer right (no prefix)
    const totalChapters = tocEntries.filter((item) => item.depth === 0 && item.number).length;
    if (chapterNumberEl) {
      chapterNumberEl.textContent = entry?.number && totalChapters > 0 ? `${entry.number}/${totalChapters}` : '-';
    }
  } catch (error) {
    log.debug('Failed to update chapter info:', error);
    chapterInfoEl.textContent = '•';
  }
}

function readFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onprogress = (e) => {
      if (e.lengthComputable && typeof onProgress === 'function') {
        const percent = Math.round((e.loaded / e.total) * 100);
        onProgress(percent);
      }
    };
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(file);
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('sw.js')
    .then((reg) => log.info('SW registered:', reg.scope))
    .catch((error) => log.warn('SW registration failed', error));
}

async function refreshServiceWorker() {
  log.info('Refreshing service worker...');
  showToast('Refreshing service worker...');
  
  if ('serviceWorker' in navigator) {
    try {
      // Unregister all service workers
      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const reg of registrations) {
        await reg.unregister();
      }
      log.info('Service workers unregistered');
      
      // Clear all caches
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map(name => caches.delete(name)));
      log.info('Caches cleared');
      
      // Reload the page
      showToast('Reloading...');
      location.reload();
    } catch (error) {
      log.error('Service worker refresh failed:', error);
      showToast('Failed to refresh service worker');
    }
  }
}

function showToast(message) {
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('visible');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('visible');
    // Clear content after hide to avoid screen reader repetition
    setTimeout(() => { toastEl.textContent = ''; }, 200);
  }, 2000);
}

function startProgress(label) {
  if (!progressEl) return;
  progressEl.classList.add('visible');
  progressEl.classList.remove('indeterminate');
  setProgress(0, label);
}

function setProgress(percent, label) {
  if (!progressEl) return;
  if (typeof percent === 'number') {
    progressEl.classList.remove('indeterminate');
    if (progressFillEl) progressFillEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  } else {
    progressEl.classList.add('indeterminate');
  }
  if (progressLabelEl && typeof label === 'string') {
    progressLabelEl.textContent = label;
  }
}

function endProgress() {
  if (!progressEl) return;
  progressEl.classList.remove('visible');
  progressEl.classList.remove('indeterminate');
  if (progressFillEl) progressFillEl.style.width = '0%';
  if (progressLabelEl) progressLabelEl.textContent = '';
}

function maybeLogProgress(kind, percent) {
  if (typeof percent !== 'number') return;
  const rounded = Math.round(percent / 25) * 25; // log in 25% increments
  if (kind === 'file') {
    if (rounded !== lastFileProgressLogged) {
      log.debug('File read progress:', `${rounded}%`);
      lastFileProgressLogged = rounded;
    }
  } else if (kind === 'download') {
    if (rounded !== lastFetchProgressLogged) {
      log.debug('Download progress:', `${rounded}%`);
      lastFetchProgressLogged = rounded;
    }
  }
}

