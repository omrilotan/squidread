# Contributing

## Layout

| Path | What it is |
| --- | --- |
| `android/` | The Android app |
| `docs/` | The website, published at [omrilotan.com/squidread](https://omrilotan.com/squidread/), with the privacy policy under `docs/privacy/` |
| `docs/reader/` | The web reader (alpha), a progressive web app published with the website. It shares the website's mascot and favicon |
| `mascot/` | Mascot artwork |

## Android

A native Kotlin app built for e-ink readers: low-power hardware and black-and-white, high-contrast screens.

- Pages are drawn by the [Readium Kotlin toolkit](https://github.com/readium/kotlin-toolkit) in a WebView, since EPUB content is HTML. Everything else (unzipping, library, menus, gestures, page turns) is native.
- Right-to-left books follow the book's page progression, or its language when that is missing. Tap zones and arrow keys mirror for RTL books, as in the web reader.
- E-ink: no animations, ripples or shadows; page turns are instant, by tap, swipe or page-turn button (`PAGE_UP`/`PAGE_DOWN`); the footer only redraws when its text changes; the system bars appear and disappear at once with the menu.
- Links: footnotes open over the page, and Back returns to where a link was followed from. Books can't open other apps or the web on their own: only web and mail links the reader taps open, in another app.
- Opens EPUB files only, without DRM. Malformed or hostile files are rejected when imported or opened rather than crashing the app.
- Fonts: the styles menu can replace the book's fonts with any `.ttf`, `.otf`, `.woff` or `.woff2` file from the `fonts` folder at the root of the device's storage. Android asks once for access to that folder. Files named like `Family-Bold.ttf` or `Family Bold Italic.ttf` are grouped into one family.
- Registers for EPUB files, so it appears in "Open with" and the share sheet, and can be set as the default app for EPUB files.
- No internet permission. The open-source licenses are in `android/app/src/main/assets/licenses.txt`, shown offline from Settings.

### Building

Requires JDK 17+ and the Android SDK (set `sdk.dir` in `android/local.properties` or `ANDROID_HOME`). The `Makefile` assumes Homebrew's `openjdk@17`; override `JAVA_HOME` if yours lives elsewhere.

| Command | Builds |
| --- | --- |
| `make android` | Debug APK |
| `make android-release` | Release APK |
| `make android-bundle` | App Bundle for Google Play |

### Releasing

Bump `versionCode` and `versionName` in `android/app/build.gradle.kts` for every release, and add its notes to [CHANGELOG.md](CHANGELOG.md). Each entry's notes are what goes into Google Play's release notes, 500 characters at most.

## Website and web reader

`make site` serves both at http://localhost:5050, with the reader under `/reader/`.
