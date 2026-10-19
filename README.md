# Squidread

<center>

![](mascot/Squid%20Read%20Flat.png)

</center>

Reading ePub files

## Web reader

`docs/reader/` is the progressive web app, published with the website at [omrilotan.com/squidread/reader](https://omrilotan.com/squidread/reader/). It shares the website's mascot and favicon.

## Website

`docs/` is the project's landing page, published at [omrilotan.com/squidread](https://omrilotan.com/squidread/), with the [privacy policy](https://omrilotan.com/squidread/privacy/) under `docs/privacy/`.

## Android

`android/` is a native Kotlin app built for e-ink readers: low-power hardware and black-and-white, high-contrast screens.

- Rendering uses the [Readium Kotlin toolkit](https://github.com/readium/kotlin-toolkit). EPUB content is HTML, so pages are drawn by a WebView; everything else (unzipping, library, menus, gestures, page turns) is native.
- Right-to-left books follow the book's page progression, or its language when that is missing. Tap zones and arrow keys mirror for RTL books, as in the web app.
- E-ink: pure black and white, inverted in the dark theme (Settings: System, the default, Light or Dark), with no animations, ripples or shadows; page turns are instant, by tap, swipe or page-turn button (`PAGE_UP`/`PAGE_DOWN`); the footer only redraws when its text changes; the system bars appear and disappear at once with the menu.
- Links: footnotes open over the page; Back returns to where a link was followed from. Books can't open other apps or the web on their own: only web and mail links the reader taps open, in another app.
- Opens EPUB files only, without DRM. Malformed or hostile files are rejected when imported or opened rather than crashing the app.
- Fonts: the styles menu can replace the book's fonts with any `.ttf`, `.otf`, `.woff` or `.woff2` file from the `fonts` folder at the root of the device's storage (where e-ink readers keep theirs). Android asks once for access to that folder. Files named like `Family-Bold.ttf` or `Family Bold Italic.ttf` are grouped into one family.
- Registers for EPUB files, so it appears in "Open with" and the share sheet, and can be set as the default app for EPUB files ("Always" in the chooser, or the app's "Open by default" settings).
- Private: no internet permission, no accounts, ads or analytics. Settings links to the website, the privacy policy and the open-source licenses (`app/src/main/assets/licenses.txt`, shown offline).

Requires JDK 17+ and the Android SDK (set `sdk.dir` in `android/local.properties` or `ANDROID_HOME`).

`make android-release` builds the APK; `make android-bundle` builds the App Bundle for Google Play. Bump `versionCode` and `versionName` in `android/app/build.gradle.kts` for every release, and add its notes to [CHANGELOG.md](CHANGELOG.md).
