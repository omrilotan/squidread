# Google Play listing

Everything the Play Console asks for, ready to paste. Nothing here is secret.

## Build

```sh
make android-bundle   # android/app/build/outputs/bundle/release/app-release.aab
```

Bump `versionCode` in `android/app/build.gradle.kts` for every upload; Play rejects a code it has seen.

## App signing

Use the existing release key as Play's **app signing key**, so copies already installed from GitHub can update from Play:

1. Play Console, **Test and release → Setup → App signing**, choose **Use a different key → Export and upload a key from Java keystore**.
2. Download the PEPK tool and the encryption key from that page, then run the command it shows against `~/.android/squidread-release.jks`.
3. Upload the resulting zip.
4. Create a new **upload key** (a separate keystore) and register its certificate on the same page. Sign bundles with the upload key from then on.

Never commit either keystore or its passwords.

## Store listing

- **App name:** Squidread
- **Short description (80):** A fast, distraction-free EPUB reader built for e-ink screens.
- **Full description:**

  > Squidread is an EPUB reader made for e-ink devices such as Boox, and pleasant on any phone or tablet.
  >
  > • Black on white with no greys, shadows or animations. Page turns are instant, by tap, swipe or page button, and the screen only redraws when something changes.
  > • Right-to-left books (Hebrew, Arabic and others) read naturally: pages, taps and the table of contents follow the book's direction.
  > • Choose what each of nine tap zones does: next page, previous page or the menu.
  > • Use your own fonts: put .ttf or .otf files in a fonts folder and pick one, or keep the book's font.
  > • Your library, offline, with covers. Every book reopens where you left off, and each open book has its own entry in the app switcher.
  > • Open books from your file manager or the share menu, and make Squidread your default EPUB app.
  > • Footnotes open in a popup; links within the book have a Back button.
  >
  > Private by design: Squidread has no internet access, no accounts, no ads and no tracking. Your books never leave your device.
  >
  > Squidread reads DRM-free EPUB files. It does not open DRM-protected books.
  >
  > Free and open source.

- **App icon:** `icon-512.png`
- **Feature graphic:** `feature-graphic.png`
- **Phone screenshots:** `screenshots/` (1080×1920), in this order: reader, rtl, fonts, contents, library
- **Category:** Books & Reference
- **Contact email:** required by Play and shown publicly; use an address you are happy to publish.
- **Website:** https://omrilotan.com/squidread/
- **Privacy policy:** https://omrilotan.com/squidread/privacy/

## App content

- **Privacy policy:** https://omrilotan.com/squidread/privacy/
- **Ads:** No, the app does not contain ads.
- **App access:** All functionality is available without special access.
- **Content rating:** Category *Reference, News, or Educational*. Answer **No** to every question (no violence, sexual content, language, controlled substances, gambling, user interaction, sharing of location or personal information, or digital purchases). Expect *Everyone* / PEGI 3.
- **Target audience:** 13 and over (13–15, 16–17, 18+). Not designed for children, which keeps it out of the Families program.
- **News app:** No.
- **Data safety:**
  - Does your app collect or share any of the required user data types? **No.**
  - Is all user data encrypted in transit? Not applicable, the app transmits nothing; answer as the form allows for apps that collect no data.
  - Account deletion: not applicable, there are no accounts.
- **Government app:** No.
- **Financial features:** None.
- **Health:** None.
- **Advertising ID:** No (the app does not use it).

## Pricing and distribution

- **Price:** Free.
- **Countries:** all available. Google does not offer the embargoed countries and regions.
- **Export laws:** accept the US export law declaration. The app contains no encryption (it computes SHA-256 hashes to name files, which is not encryption under the EAR) and is publicly available open source, so no classification or export report is needed.

## Testing

A new personal developer account must run a **closed test with at least 12 testers for 14 consecutive days** before it can apply for production access. Upload the bundle to a closed testing track, add testers by email list, and share the opt-in link.
