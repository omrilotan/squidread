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
        log.info('No books in library');
        // No books available, open menu on Library tab
        switchPanelSection('library');
        panelEl.classList.remove('hidden');
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
    if (typeof target.closest === 'function' && target.closest('a[href], .readerFooter')) return;
    handleViewerZoneClick(event.clientX, event.clientY);
  };
  readerEl?.addEventListener('click', handleViewerPointer, true);
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

  // Wire up the Add EPUB button to open file picker
  const addEpubBtn = document.getElementById('addEpubBtn');
  addEpubBtn?.addEventListener('click', () => {
    filePicker.click();
  });

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
      if (currentRecord?.id === id) {
        closePanel();
      } else {
        await loadBook(id);
      }
    }

    if (actionElement.matches('[data-action="delete"]')) {
      await db.delete('books', id);
      if (currentRecord?.id === id) {
        clearViewer();
      }
      await renderLibrary();
    }
  });

  tocListEl?.addEventListener('click', async (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const button = target.closest('.tocItem');
    if (!button) return;
    const href = button.dataset.href;
    if (!href || !rendition) return;
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

/** The book's pages take the theme's two colours too. */
function applyBookTheme() {
  if (!rendition) return;
  const styles = getComputedStyle(document.documentElement);
  rendition.themes.override('color', styles.getPropertyValue('--ink').trim(), true);
  rendition.themes.override('background', styles.getPropertyValue('--paper').trim(), true);
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
  
  // New book - extract title and cover from EPUB
  let title = name.replace(/\.epub$/i, '');
  let coverDataUrl = null;
  
  try {
    await ensureEpubDepsLoaded();
    const tempBook = await ePub(blob).opened;
    title = tempBook.packaging?.metadata?.title || title;
    
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

async function renderLibrary() {
  log.debug('Rendering library');
  const books = await db.getAll('books');
  books.sort((a, b) => (b.lastOpened || b.createdAt) - (a.lastOpened || a.createdAt));
  
  // Clear library but keep the Add EPUB button (and its wired handlers)
  const addButton = libraryEl.querySelector('.libraryAddItem');
  libraryEl.innerHTML = '';
  if (addButton) libraryEl.appendChild(addButton);
  
  if (!books.length) {
    return;
  }

  for (const record of books) {
    const li = document.createElement('li');
    li.className = 'libraryItem';

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
}

function renderToc(tocItems = []) {
  if (!tocListEl) return;
  tocListEl.innerHTML = '';
  if (!tocItems.length) {
    const empty = document.createElement('li');
    empty.className = 'meta';
    empty.textContent = 'No table of contents available.';
    tocListEl.appendChild(empty);
    return;
  }

  const addItems = (items, level = 0) => {
    items.forEach((item) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'tocItem';
      btn.dataset.href = item.href || '';
      if (item.cfi) btn.dataset.cfi = item.cfi;
      btn.textContent = item.label || item.title || 'Untitled';
      btn.style.paddingInlineStart = `${16 + level * 16}px`;
      if (!item.href) {
        btn.disabled = true;
      }
      li.appendChild(btn);
      tocListEl.appendChild(li);
      if (item.subitems && item.subitems.length) {
        addItems(item.subitems, level + 1);
      }
    });
  };

  addItems(tocItems);
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
      
      // Handle internal links
      if (!doc.body.dataset.squidreadLinksBound) {
        doc.body.dataset.squidreadLinksBound = '1';
        const links = doc.querySelectorAll('a[href]');
        links.forEach(link => {
          link.addEventListener('click', async (e) => {
            const href = link.getAttribute('href');
            if (!href) return;
            e.preventDefault();

            // Links out of the book open in a new tab, never inside the reader.
            let target = null;
            try {
              target = new URL(href, doc.baseURI);
            } catch (error) {}
            if (target && (target.protocol === 'http:' || target.protocol === 'https:')) {
              window.open(target.href, '_blank', 'noopener,noreferrer');
              return;
            }
            
            try {
              // Try direct navigation first
              await rendition.display(href);
            } catch (error) {
              log.debug('Direct link navigation failed, trying spine match:', href, error);
              
              // Fallback: search spine by href
            const targetSpine = findSpineItemByHref(href);
              
              if (targetSpine) {
                // If there's an anchor, keep it
                const anchor = href.includes('#') ? href.split('#')[1] : null;
                if (anchor) {
                  await rendition.display(targetSpine);
                  // Try to scroll to anchor after display
                  setTimeout(() => {
                    // The book chooses the anchor; looked up by name, never as a selector.
                    const targetEl = doc.getElementById(anchor) || doc.getElementsByName(anchor)[0];
                    if (targetEl) targetEl.scrollIntoView();
                  }, 100);
                } else {
                  await rendition.display(targetSpine);
                }
              }
            }
          });
        });
      }

      // Click/keydown handlers are attached via rendition content hooks.
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
  
  // Get page progression direction (RTL or LTR)
  const pageDir = book.packaging?.metadata?.direction;
  isRTL = pageDir === 'rtl';
  
  // Set TOC direction
  tocListEl.dir = isRTL ? 'rtl' : 'ltr';
  
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
      }
      fitImagePages(doc);
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

    try {
      const nav = await book.loaded.navigation;
      renderToc(nav?.toc || []);
    } catch (error) {
      log.warn('Failed to load TOC:', error);
      renderToc([]);
    }
    
    // Final CSS injection
    await wait(150);
    injectContentCSS();
  } catch (error) {
    log.error('Failed to display EPUB:', error);
  }

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
  currentFontSize = Math.max(0.5, Math.min(2.0, currentFontSize + delta));
  applyFontSize();
  localStorage.setItem('squidreadFontSize', currentFontSize);
}

function resetFontSize() {
  currentFontSize = 1.0;
  applyFontSize();
  localStorage.setItem('squidreadFontSize', currentFontSize);
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
  
  // Scroll active TOC item into view if switching to contents
  if (section === 'contents') {
    setTimeout(() => {
      const activeItem = tocListEl?.querySelector('.tocItem.active');
      if (activeItem) {
        activeItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }, 0);
  }
}

function clearViewer() {
  setViewerEmptyState(true);
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
  renderToc([]);
}

function setViewerEmptyState(visible) {
  if (!viewerEmptyStateEl) return;
  viewerEmptyStateEl.classList.toggle('hidden', !visible);
}

function openPanel() {
  if (panelEl.classList.contains('hidden')) {
    togglePanel();
  }
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

  if (event.key === 'Escape') {
    event.preventDefault();
    togglePanel();
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
  isTurningPage = true;
  rendition.next().catch(() => {
    isTurningPage = false;
  });
}

function goPrevPage() {
  if (!rendition || isTurningPage) return;
  isTurningPage = true;
  rendition.prev().catch(() => {
    isTurningPage = false;
  });
}

function handleRenditionContentPointer(event) {
  const target = event.target;
  if (!isDomElement(target)) return;
  if (typeof target.closest === 'function' && target.closest('a[href]')) return;

  event.preventDefault?.();
  event.stopImmediatePropagation?.();
  event.stopPropagation?.();

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
    
    // Try to find chapter name from TOC and highlight it
    let chapterName = '';
    let activeHref = null;
    let currentChapterNum = '';
    let totalChapters = 0;
    
    if (book?.navigation?.toc) {
      // Count only TOP-LEVEL chapters
      totalChapters = book.navigation.toc.filter(item => item.href).length;
      
      // Find current chapter with hierarchical numbering
      const findInTocWithNumbers = (items, parentNum = '') => {
        let chapterCount = 0;
        for (const item of items) {
          if (item.href) {
            chapterCount++;
            const currentNum = parentNum ? `${parentNum}.${chapterCount}` : `${chapterCount}`;
            
            if (section.href && section.href.includes(item.href.split('#')[0])) {
              activeHref = item.href;
              return {
                name: item.label || item.title,
                number: currentNum
              };
            }
            
            if (item.subitems) {
              const found = findInTocWithNumbers(item.subitems, currentNum);
              if (found) return found;
            }
          }
        }
        return null;
      };
      
      const found = findInTocWithNumbers(book.navigation.toc);
      if (found) {
        chapterName = found.name;
        currentChapterNum = found.number;
      }
    }
    
    // Update active TOC item
    if (tocListEl && activeHref) {
      // Clear all active states
      tocListEl.querySelectorAll('.tocItem.active').forEach(item => {
        item.classList.remove('active');
      });
      // Set active state on matching item
      const activeButton = [...tocListEl.querySelectorAll('.tocItem')].find((item) => item.dataset.href === activeHref);
      if (activeButton) {
        activeButton.classList.add('active');
      }
    }
    
    // Build chapter info display
    const parts = [];
    
    // Add chapter name
    if (chapterName) {
      parts.push(chapterName);
    }
    
    // Add page within chapter (no prefix)
    const displayed = rendition?.location?.start?.displayed;
    if (displayed) {
      parts.push(`${displayed.page}/${displayed.total}`);
    }
    
    chapterInfoEl.textContent = parts.filter(Boolean).join(' • ') || '•';
    
    // Update chapter number in footer right (no prefix)
    if (chapterNumberEl && currentChapterNum && totalChapters > 0) {
      chapterNumberEl.textContent = `${currentChapterNum}/${totalChapters}`;
    } else if (chapterNumberEl) {
      chapterNumberEl.textContent = '-';
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

