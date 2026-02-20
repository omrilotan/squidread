import { openDB } from 'https://unpkg.com/idb?module';

const libraryEl = document.getElementById('library');
const prevBtn = document.getElementById('prev');
const nextBtn = document.getElementById('next');
const menuBtn = document.getElementById('menuBtn');
const closePanelBtn = document.getElementById('closePanel');
const swRefreshLink = document.getElementById('swRefreshLink');
const panelEl = document.getElementById('panel');
const filePicker = document.getElementById('filePicker');
const toastEl = document.getElementById('toast');
const viewerEl = document.getElementById('viewer');
const tocListEl = document.getElementById('tocList');
const progressEl = document.getElementById('progress');
const progressFillEl = document.getElementById('progressFill');
const progressLabelEl = document.getElementById('progressLabel');
const clockEl = document.getElementById('clock');
const chapterInfoEl = document.getElementById('chapterInfo');
const progressPercentEl = document.getElementById('progressPercent');
const menuTitleEl = document.getElementById('menuTitle');
const librarySectionEl = document.getElementById('librarySection');
const viewerEmptyStateEl = document.getElementById('viewerEmptyState');

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

(async function init() {
  log.info('App init start');
  db = await openDB('squidread', 1, {
    upgrade(upgradeDB) {
      upgradeDB.createObjectStore('books', { keyPath: 'id' });
    },
  });

  wireEvents();
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
  prevBtn.addEventListener('click', () => rendition?.prev());
  nextBtn.addEventListener('click', () => rendition?.next());
  menuBtn.addEventListener('click', () => togglePanel());
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
      const baseHref = href.split('#')[0];
      let targetSpine = null;
      
      if (book?.spine) {
        for (let i = 0; i < book.spine.length; i++) {
          const spineItem = book.spine.get(i);
          if (spineItem?.href && spineItem.href.includes(baseHref)) {
            targetSpine = spineItem;
            break;
          }
        }
      }
      
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
    resizeRendition();
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
    if (event.defaultPrevented) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isEditableTarget(event.target)) return;

    if (event.key === 'm' || event.key === 'M') {
      event.preventDefault();
      openPanel();
      return;
    }

    if (event.key === 'Escape') {
      if (!panelEl.classList.contains('hidden')) {
        event.preventDefault();
        closePanel();
      }
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
        rendition?.prev();
      } else {
        rendition?.next();
      }
      return;
    }

    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (isRTL) {
        rendition?.next();
      } else {
        rendition?.prev();
      }
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
}

function isEditableTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
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
  
  // Clear library but keep the Add EPUB button
  const addButton = libraryEl.querySelector('.libraryAddItem');
  libraryEl.innerHTML = '';
  
  // Always restore the Add EPUB button as the first item
  if (addButton) {
    libraryEl.appendChild(addButton);
  } else {
    // If for some reason it doesn't exist, recreate it
    const li = document.createElement('li');
    li.className = 'libraryAddItem';
    li.innerHTML = `
      <button id="addEpubBtn" class="addEpubButton">
        <span class="addEpubPlus">+</span>
        <span class="addEpubText">Add EPUB</span>
      </button>
      <input type="file" id="filePicker" accept="application/epub+zip,.epub" class="hidden" />
    `;
    libraryEl.appendChild(li);
    // Re-wire the button
    const newAddBtn = libraryEl.querySelector('#addEpubBtn');
    const newFilePicker = libraryEl.querySelector('#filePicker');
    newAddBtn?.addEventListener('click', () => {
      newFilePicker?.click();
    });
    newFilePicker?.addEventListener('change', async () => {
      const file = newFilePicker?.files?.[0];
      if (!file) return;
      await handleLocalFile(file);
      newFilePicker.value = '';
    });
  }
  
  if (!books.length) {
    return;
  }

  for (const record of books) {
    const li = document.createElement('li');
    li.className = 'libraryItem';

    const hasCoverData = record.coverDataUrl && record.coverDataUrl.startsWith('data:');
    if (hasCoverData) {
      li.style.backgroundImage = `url(${record.coverDataUrl})`;
      li.style.backgroundSize = 'cover';
      li.style.backgroundPosition = 'center';
    }

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
      // Cover exists, no need to show placeholder
      coverContainer.className = 'coverContainer hasCover';
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
      btn.style.paddingLeft = `${10 + level * 12}px`;
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

const wait = (ms) => new Promise((res) => setTimeout(res, ms));

function injectContentCSS() {
  // Minimal CSS - only prevent images from overflowing
  const iframes = document.querySelectorAll('.viewer iframe');
  iframes.forEach(iframe => {
    try {
      const doc = iframe.contentDocument || iframe.contentWindow?.document;
      if (!doc) return;
      
      // Check if already injected
      if (doc.querySelector('#squidread-content-styles')) return;
      
      const style = doc.createElement('style');
      style.id = 'squidread-content-styles';
      style.textContent = `
        img, svg, video, canvas, iframe {
          max-width: 100% !important;
          height: auto !important;
        }
      `;
      doc.head.appendChild(style);
      
      // Handle internal links
      const links = doc.querySelectorAll('a[href]');
      links.forEach(link => {
        link.addEventListener('click', async (e) => {
          const href = link.getAttribute('href');
          if (!href || href.startsWith('http')) return; // Skip external links
          
          e.preventDefault();
          
          try {
            // Try direct navigation first
            await rendition.display(href);
          } catch (error) {
            log.debug('Direct link navigation failed, trying spine match:', href, error);
            
            // Fallback: search spine by href
            const baseHref = href.split('#')[0];
            let targetSpine = null;
            
            if (book?.spine) {
              for (let i = 0; i < book.spine.length; i++) {
                const spineItem = book.spine.get(i);
                if (spineItem?.href && spineItem.href.includes(baseHref)) {
                  targetSpine = spineItem;
                  break;
                }
              }
            }
            
            if (targetSpine) {
              // If there's an anchor, keep it
              const anchor = href.includes('#') ? href.split('#')[1] : null;
              if (anchor) {
                await rendition.display(targetSpine);
                // Try to scroll to anchor after display
                setTimeout(() => {
                  const targetEl = doc.querySelector(`#${anchor}, [name="${anchor}"]`);
                  if (targetEl) targetEl.scrollIntoView();
                }, 100);
              } else {
                await rendition.display(targetSpine);
              }
            }
          }
        });
      });
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
    menuTitleEl.textContent = record.title || record.name || 'Squid Reader';
  }

  try {
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
  
  // Switch button positions for RTL books
  if (isRTL) {
    log.debug('Book is RTL - swapping button positions');
    // For RTL: Next on left (0), Menu in middle (1), Prev on right (2)
    prevBtn.style.left = 'auto';
    prevBtn.style.right = '0';
    prevBtn.style.width = '33.33%';
    
    nextBtn.style.left = '0';
    nextBtn.style.right = 'auto';
    nextBtn.style.width = '33.33%';
  } else {
    log.debug('Book is LTR - standard button positions');
    // For LTR: Prev on left (0), Menu in middle (1), Next on right (2)
    prevBtn.style.left = '0';
    prevBtn.style.right = 'auto';
    prevBtn.style.width = '33.33%';
    
    nextBtn.style.left = 'auto';
    nextBtn.style.right = '0';
    nextBtn.style.width = '33.33%';
  }
  
  rendition = book.renderTo('viewer', {
    width: '100%',
    height: '100%',
    spread: 'none',
    allowScriptedContent: true,
  });

  rendition.on('relocated', async (location) => {
    log.debug('Relocated:', location?.start?.cfi);
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
    
    // Apply current font size setting
    applyFontSize();
    
    // Wait a bit for the iframe to be created
    await wait(50);
    
    resizeRendition();
    setTimeout(() => {
      resizeRendition();
      lockIframeHeight();
    }, 0);
    setTimeout(() => {
      lockIframeHeight();
    }, 150);
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
    
    // Inject CSS directly into the iframe to prevent scrolling
    setTimeout(() => {
      injectContentCSS();
    }, 100);
    setTimeout(() => {
      injectContentCSS();
    }, 300);
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
  if (!rendition) return;
  
  // Apply font size to the book's body element
  rendition.themes.fontSize(`${currentFontSize}em`);
  log.debug(`Font size adjusted to ${currentFontSize}em`);
}

function switchPanelSection(section) {
  // Update nav buttons
  document.querySelectorAll('.navBtn').forEach(btn => btn.classList.remove('active'));
  document.getElementById(`nav${section.charAt(0).toUpperCase() + section.slice(1)}`)?.classList.add('active');
  
  // Update sections
  document.querySelectorAll('.panelSection').forEach(sec => sec.classList.remove('active'));
  document.getElementById(`${section}Section`)?.classList.add('active');
  
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
  if (menuTitleEl) {
    menuTitleEl.textContent = 'Squid Reader';
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

function getActivePanelSection() {
  const activeSection = document.querySelector('.panelSection.active');
  if (!activeSection?.id) return 'styles';
  return activeSection.id.replace(/Section$/, '');
}

function updatePosition(location) {
  if (!location) return;
  
  // Update overall book progress
  let percentage = 0;
  if (locationsReady && book?.locations?.length) {
    percentage = (location.start?.location / book.locations.total) * 100;
  }
  if (Number.isFinite(percentage)) {
    const rounded = Math.min(100, Math.max(0, percentage));
    progressPercentEl.textContent = `${rounded.toFixed(0)}%`;
  }
  
  // Update chapter info
  updateChapterInfo(location);
}

function updateClock() {
  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
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
    if (book?.navigation?.toc) {
      const findInToc = (items) => {
        for (const item of items) {
          if (item.href && section.href && section.href.includes(item.href.split('#')[0])) {
            activeHref = item.href;
            return item.label || item.title;
          }
          if (item.subitems) {
            const found = findInToc(item.subitems);
            if (found) return found;
          }
        }
        return null;
      };
      const found = findInToc(book.navigation.toc);
      if (found) chapterName = found;
    }
    
    // Update active TOC item
    if (tocListEl && activeHref) {
      // Clear all active states
      tocListEl.querySelectorAll('.tocItem.active').forEach(item => {
        item.classList.remove('active');
      });
      // Set active state on matching item
      const activeButton = tocListEl.querySelector(`.tocItem[data-href="${activeHref}"]`);
      if (activeButton) {
        activeButton.classList.add('active');
      }
    }
    
    // Calculate page within section
    const displayed = rendition?.location?.start?.displayed;
    if (displayed) {
      chapterInfoEl.textContent = [chapterName, `${displayed.page}/${displayed.total}`].filter(Boolean).join(' • ');
    } else {
      chapterInfoEl.textContent = chapterName || '•';
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

