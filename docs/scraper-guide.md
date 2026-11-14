# Scraper guide

[Documentation index](README.md) · [Setup and login](setup-and-login.md) · [Output reference](output-reference.md)

## Choose the input

Edit `.env`. For client-supplied places, provide pipe-separated place IDs or
supported URLs:

```dotenv
PLACE_IDS=ChIJ...|ChIJ...
PLACE_URLS=https://www.google.com/maps/search/?api=1&query=Example&query_place_id=ChIJ...|https://...
MAX_PLACES=20
```

When either direct-input list is present, area discovery is skipped. Clear both
lists to search by business type and area:

```dotenv
QUERIES=cafes|drink
AREAS=Kuala Lumpur City Centre|Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur
MAX_PLACES=20
MAX_CANDIDATES_PER_AREA=150
```

`MAX_PLACES` is one shared final cap across all searches and areas, not a limit
per area.

## Recommended production settings

```dotenv
HEADLESS=true
REQUIRE_GOOGLE_SIGN_IN=true
SAFE_BATCH_SIZE=4
SCRAPE_PHOTOS=true
PHOTO_TABS=Menu|By owner|All|Food & drink|Vibe
PHOTO_LIMIT_MENU=8
PHOTO_LIMIT_BY_OWNER=4
PHOTO_LIMIT_ALL=30
PHOTO_LIMIT_FOOD_DRINK=8
PHOTO_LIMIT_VIBE=3
PHOTO_CAPTURE_UPLOAD_DATE=true
PHOTO_DATE_BATCH_SIZE=10
PHOTO_DATE_CONCURRENCY=1
PHOTO_DATE_WAIT_MS=300
PHOTO_PROBE_CONCURRENCY=2
SCRAPE_REVIEWS=true
REVIEW_MAX_PER_PLACE=50
REVIEW_SORT=newest
```

Do not raise `PHOTO_DATE_CONCURRENCY` above 1 on the validated laptop. Two date
pages exceeded Crawlee's available-memory limit.

## Run a new batch

```powershell
npm run start:safe
```

Safe mode restarts Chrome after each small batch to release memory. A fresh run
creates the next numbered folder under `output`, such as `Running#2`.

If the same run is interrupted or safety-stopped, fix the condition and resume
the preserved queue:

```powershell
npm run resume:safe
```

Never use `resume:safe` for a different target list. Use `start:safe` to create
a fresh queue for new inputs.

## One-place and visible tests

```powershell
npm run scrape:one -- "ChIJ..."
npm run scrape:one -- "https://www.google.com/maps/search/?api=1&query=Example&query_place_id=ChIJ..."
npm run start:visible
```

One-place mode writes one JSON object into a new numbered run. Visible mode is
for selector and account troubleshooting; headless mode is supported for normal
batches.

## What the scraper collects

- Place and feature IDs, latitude, longitude, and business closure status
- Name, rating, review count, category, address, contact, and opening hours
- Displayed per-person price range when Google provides one
- Typed-menu sections and dishes
- Popular Times, daily peaks, overall peak, and quiet periods
- About attributes
- Five photo tabs with IDs, URLs, tabs, upload dates, and dimensions
- Up to 50 newest privacy-limited reviews
- Malaysia brand-size values only when a verified catalog entry exists

Phone and website remain under `contact`; address is top-level. Reviewer identity
and owner responses are intentionally excluded.

## Typed-menu rules

- A place is never excluded because it lacks a typed menu.
- `menu` is `null` when no typed dishes are available.
- Each item keeps section, name, description, `priceText`, `priceValue`, and
  `currency`.
- Missing prices remain `null`; prices and currencies are never guessed.
- `menuScrape.tabExists` is separate from `menuScrape.status`.

## Status meanings

Menu, photos, and reviews use:

- `success`: the UI loaded and valid data was collected.
- `none`: the UI loaded and absence was confirmed.
- `failed`: the UI or data did not load reliably.

The run stops instead of saving `none` when Maps shows unusual traffic, CAPTCHA,
a signed-out profile, or another safety block. Repeated loaded Menu tabs with no
items also trigger a stop. Failed runs exit non-zero and print `RUN_SUMMARY`.

## Main configuration groups

| Group | Common variables |
| --- | --- |
| Targets | `QUERIES`, `AREAS`, `PLACE_IDS`, `PLACE_URLS`, `ONE_PLACE` |
| Limits | `MAX_PLACES`, `MAX_CANDIDATES_PER_AREA` |
| Search/menu | `SCROLL_WAIT_MS`, `MENU_MAX_ATTEMPTS`, `MENU_SCROLL_MAX_ROUNDS` |
| Photos | `PHOTO_TABS`, per-tab limits, `PHOTO_CAPTURE_UPLOAD_DATE` |
| Reviews | `SCRAPE_REVIEWS`, `REVIEW_MAX_PER_PLACE`, `REVIEW_SORT` |
| Browser | `HEADLESS`, `CHROME_PROFILE_DIR`, `REQUIRE_GOOGLE_SIGN_IN` |
| Safe mode | `SAFE_BATCH_SIZE`, `SAFE_RESTART_DELAY_MS` |
| Output | `OUTPUT_ROOT`, `CRAWLEE_STORAGE_DIR` |

Use separate output and Crawlee storage directories for benchmarks or smoke
tests so production results are not overwritten.

After a successful run, continue with [photo classification](photo-classification.md).
