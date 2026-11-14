# Google Maps café and drinks data pipeline

This project uses Crawlee, Playwright, CLIP, and OCR to collect and review public
Google Maps data for cafés and drink businesses in Malaysia. New photo-analysis
runs use PaddleOCR for layout-aware menu text and price candidates; Tesseract is
retained as a historical fallback. The scraper can run multiple search terms
across multiple Kuala Lumpur areas, distribute the final place limit fairly,
visit each selected place, and export JSON and CSV files.

The current workflow has three clearly separated sections:

1. The main scraper discovers locations and collects place details, structured
   menus, Popular times, About attributes, photos, 50 newest reviews, and
   Malaysia brand-size fields.
2. Photo classification classifies saved photo URLs, supports manual browser
   labelling, and calculates category evaluation metrics.
3. Photo analysis runs PaddleOCR on menu photos, structures OCR menu evidence,
   supports manual price review, and compares photo menus with typed menus.

The classification and analysis stages do not modify the selected scraper
`restaurants.json`. Every command writes into a dated and timed run folder.

## End-to-end workflow

After installation and the one-time Google login, the normal sequence is:

```powershell
# Main location, menu, Popular-times, About, photo, and review scrape.
npm run start:safe

# One-time setup before the first PaddleOCR analysis.
npm run setup:paddleocr

# Independent CLIP classification and PaddleOCR of the saved photo URLs.
npm run analyze:photos

# Convert a PaddleOCR result into evidence-backed structured menu candidates.
npm run parse:menu-ocr -- "output\photo-analysis\<date>\<time>\paddleocr\json\paddleocr-analysis.json"

# Manually categorize unresolved OCR price lines in a local browser.
npm run label:menu-ocr

# Build an exact file-to-place photo map for downloaded OCR images.
npm run build:photo-map -- --selection "<selection.json>" --photo-list "output\scraper\<date>\<time>\json\photo-list.json" --output "<photo-map.csv>"

# Match Google typed-menu offers against structured photo-menu offers.
npm run match:menus -- --restaurants "output\scraper\<date>\<time>\json\restaurants.json" --structured "<structured-menu.json>" --photo-map "<photo-map.csv>"

# Export the menu matching result to a client-readable Excel workbook.
npm run export:report -- "<menu-matches.json>"

# Manual image-category and optional OCR-text validation.
npm run label:photos

# Accuracy, precision, recall, F1, confusion matrix, and optional OCR accuracy.
npm run analyze:photos:evaluate

# Optional standalone menu-photo benchmark.
npm run recon:paddleocr -- "C:\path\to\menu-photos"
```

Photo classification and analysis run after the main scrape. Do not run
`npm run login` and a main scrape simultaneously because they share
`.chrome-profile`.

## Current capabilities

The scraper collects:

- place name and category
- rating from 1 to 5 and review count
- displayed per-person price range, such as `RM 20–40 per person`, when Google provides one
- address, phone number, and website
- weekly opening hours
- Google Maps menu categories and dishes
- hourly Google Maps Popular times for all available days, with daily and overall peak and quietest periods
- structured information from the About tab, including service options, accessibility, offerings, dining options, amenities, atmosphere, planning, and payments
- up to a configurable number of Google Maps photos, including photo ID, full-size image URL, source tab, width, height, and optional upload date
- photo-scrape status so unavailable photo tabs can be distinguished from failed page loads
- up to 50 newest review sentences per place, without reviewer identity fields or owner responses
- separate `success`, `none`, or `failed` status objects for menu, photos, and reviews
- Google place ID, feature ID, latitude, longitude, and closure status
- an independent top-level `address` field
- a grouped `contact` object containing only phone and website
- Google Maps URL, source query, search area, and scrape timestamp

For every structured menu dish, the scraper returns:

- `name`
- `description`
- `priceText`: the price exactly as displayed by Google
- `priceValue`: a numeric value only when Google shows one explicit price
- `currency`: normalized currency code when an explicit currency is present

Menu categories are opened individually. Dish information is read from the active Google Maps Menu region, and duplicate copies are merged by category and dish name. Missing price fields remain `null`; the scraper never estimates or invents prices.

Example:

```json
{
  "name": "Example Restaurant",
  "rating": 4.8,
  "reviewCount": 1070,
  "priceLevel": "RM 20–40 per person",
  "menu": {
    "source": "google_maps",
    "sections": [
      {
        "name": "Mains",
        "items": [
          {
            "name": "Example Dish",
            "description": "Description displayed by Google",
            "priceText": "RM 28.00",
            "priceValue": 28,
            "currency": "MYR"
          },
          {
            "name": "Dish Without a Published Price",
            "description": null,
            "priceText": null,
            "priceValue": null,
            "currency": null
          }
        ]
      }
    ]
  }
}
```

If Google Maps does not provide typed dishes, `menu` is `null`. `menuScrape`
separately records whether the Menu tab existed, whether it loaded, and whether
the result was `success`, `none`, or `failed`. Places without menu dishes remain
in the output.

## Requirements

- Node.js 20 or newer
- Python 3.12 for PaddleOCR photo analysis (the validated Windows version)
- Google Chrome
- Windows PowerShell for the command examples below
- sufficient disk space for the Chrome profile, npm packages, model caches, and
  timestamped analysis results
- a stable connection to Google Maps and Google-hosted photo URLs

The validated low-memory photo-analysis setup uses CPU inference with the
quantized model. More RAM reduces Windows swapping and Chrome crashes. Faster
internet improves discovery, detail pages, review scrolling, and photo
downloads. GPU acceleration is not enabled in the validated configuration.

## Installation

```powershell
npm install
npx playwright install chromium
```

The first photo-analysis run downloads and caches the configured CLIP model and
the official PaddleOCR models. Later runs reuse `.cache/transformers` and the
Paddle model cache in the current Windows user profile. Tesseract fallback runs
continue to reuse `.cache/tesseract`.

PaddleOCR is installed into an isolated `.venv-paddleocr` environment so it
does not change the Node.js scraper dependencies. This setup is required before
the first `npm run analyze:photos` or standalone PaddleOCR run:

```powershell
npm run setup:paddleocr
```

The first PaddleOCR run downloads its official models. Later runs reuse the
model cache under the current Windows user profile.

## Command reference

| Command | Purpose |
| --- | --- |
| `npm run login` | Open normal Chrome with the dedicated scraper profile for manual sign-in. |
| `npm start` | Run the main scraper in one Chrome process; best for short tests. |
| `npm run scrape:one -- "<ChIJ ID or Maps URL>"` | Skip discovery and write one object into a new dated scraper run. |
| `npm run start:visible` | Run the main scraper with `HEADLESS=false` for this command. |
| `npm run start:safe` | Start a fresh main scrape in restartable Chrome batches. |
| `npm run resume:safe` | Continue the existing Crawlee queue without purging completed work. |
| `npm run analyze:photos` | Start a new photo classification and OCR run. |
| `npm run analyze:photos:resume` | Resume the newest incomplete photo-analysis checkpoint. |
| `npm run label:photos` | Open the local browser photo-labelling interface. |
| `npm run analyze:photos:evaluate` | Recalculate photo and optional OCR metrics from saved labels. |
| `npm run setup:paddleocr` | Create the isolated Python environment and install the pinned PaddleOCR dependencies. |
| `npm run recon:paddleocr -- "<image-or-folder>"` | Run layout-aware PaddleOCR on one menu image or every supported image in a folder. |
| `npm run parse:menu-ocr -- "<paddleocr-analysis.json>"` | Independently pair OCR names, descriptions, and prices using layout geometry. |
| `npm run label:menu-ocr` | Review and categorize unpaired OCR price lines in a local browser. |
| `npm run test:menu-parser` | Run the synthetic safety tests for menu OCR pairing and evaluation. |
| `npm run build:photo-map -- --selection "<selection>" --photo-list "<photo-list>"` | Create an exact `fileName,placeId,photoId` CSV without name matching. |
| `npm run match:menus -- --restaurants "<restaurants.json>" --structured "<structured-menu.json>" --photo-map "<photo-map.csv>"` | Compare typed Google menu offers with structured photo-menu offers. |
| `npm run export:report -- "<menu-matches.json>"` | Create `menu-check.xlsx` in that matching run's `xlsx` folder. |
| `npm run test:menu-matching` | Run the matcher and Excel-report synthetic tests. |
| `npm run test:output-paths` | Verify dated run creation, type folders, collision handling, and Python stage reuse. |
| `npm run export:excel` | Rebuild Excel from the newest scraper run; an exact JSON path can be supplied after `--`. |

## Google Maps login

Anonymous automated browsers may receive a restricted Maps interface without the Menu, Reviews, or menu-category tabs. Create and sign in to the scraper's dedicated Chrome profile once:

```powershell
npm run login
```

This opens normal installed Chrome with an isolated profile stored in `.chrome-profile`.

1. Sign in to Google.
2. Open Google Maps and confirm that the full restaurant interface is available.
3. Close every Chrome window that belongs to this dedicated profile.
4. Return to the terminal and press Enter if requested.

`npm start` reuses this profile automatically. You do not need to run `npm run login` before every scrape; run it again only if Google expires the session or requests sign-in. Do not run `npm run login` and `npm start` at the same time because Chrome cannot safely open the same profile twice.

The profile contains sensitive session data, is excluded from Git, and must never be shared. The scraper does not access or modify your regular Chrome profile.

## Configuration

Copy `.env.example` to `.env` if `.env` does not already exist, then edit the values:

```dotenv
QUERY=restaurants
# Optional separate searches, combined and deduplicated into one output.
# QUERIES=cafes|drinks
AREA=Kuala Lumpur, Malaysia
PLACE_IDS=
PLACE_URLS=
ONE_PLACE=
MAX_PLACES=20
MAX_CANDIDATES_PER_AREA=150
AREAS=Kuala Lumpur City Centre|Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur
MAX_STALLED_SCROLLS=12
SCROLL_WAIT_MS=2000
MENU_MAX_ATTEMPTS=2
MENU_SCROLL_MAX_ROUNDS=80
MENU_SCROLL_WAIT_MS=350
MAX_CONSECUTIVE_EMPTY_MENUS=3
REQUIRE_GOOGLE_SIGN_IN=true
HEADLESS=true
CHROME_PROFILE_DIR=.chrome-profile
SCRAPE_PHOTOS=true
PHOTO_TABS=Menu|By owner|All|Food & drink|Vibe
PHOTO_MAX_PER_PLACE=30
PHOTO_LIMIT_MENU=8
PHOTO_LIMIT_BY_OWNER=4
PHOTO_LIMIT_ALL=30
PHOTO_LIMIT_FOOD_DRINK=8
PHOTO_LIMIT_VIBE=3
PHOTO_SCAN_LIMIT=30
PHOTO_SCROLL_ROUNDS=120
PHOTO_DATE_BATCH_SIZE=10
PHOTO_DATE_CONCURRENCY=1
PHOTO_DATE_WAIT_MS=300
PHOTO_PROBE_CONCURRENCY=2
PHOTO_CAPTURE_UPLOAD_DATE=true
SCRAPE_REVIEWS=true
REVIEW_MAX_PER_PLACE=50
REVIEW_SORT=newest
```

### Configuration reference

| Setting | Meaning |
| --- | --- |
| `QUERY` | Google Maps search phrase, such as `restaurants` or `halal restaurants`. An exact restaurant name is also supported. |
| `QUERIES` | Optional `\|`-separated search phrases, such as `cafes\|drinks`. Takes precedence over `QUERY`; all query/area combinations are searched and deduplicated. |
| `AREA` | Single fallback search area. Used only when `AREAS` is empty or unset. |
| `AREAS` | Multiple search areas separated by `\|`. This takes precedence over `AREA`. |
| `PLACE_IDS` | Optional `\|`-separated Google place IDs beginning with `ChIJ`. Area discovery is skipped when present. |
| `PLACE_URLS` | Optional `\|`-separated direct Google Maps URLs. The `https://www.google.com/maps/search/?api=1&query=...&query_place_id=ChIJ...` format is supported. |
| `ONE_PLACE` | Optional single place ID or URL used by `npm run scrape:one` when no command-line value is supplied. |
| `MAX_PLACES` | Shared maximum number of restaurants in the final output, not a per-area limit. |
| `MAX_CANDIDATES_PER_AREA` | Maximum discovery candidates collected from each configured area before final selection. |
| `MAX_STALLED_SCROLLS` | Number of result-list scrolls with no new places before discovery stops. |
| `SCROLL_WAIT_MS` | Delay between result-list scrolls, in milliseconds. Increase it for slow connections. |
| `MENU_MAX_ATTEMPTS` | Typed-menu load attempts before a result is marked `failed`. |
| `MENU_SCROLL_MAX_ROUNDS` | Maximum incremental scroll rounds for each Menu category. |
| `MENU_SCROLL_WAIT_MS` | Delay after each typed-menu scroll, in milliseconds. |
| `MAX_CONSECUTIVE_EMPTY_MENUS` | Safety stop threshold for consecutive places where the Menu tab loads but contains zero typed dishes. |
| `REQUIRE_GOOGLE_SIGN_IN` | Stop the run when the dedicated Maps profile is signed out. Recommended `true`. |
| `HEADLESS` | Runs Chrome without a visible window when `true`. The current menu and five-tab photo workflow is verified headlessly. |
| `CHROME_PROFILE_DIR` | Dedicated signed-in Chrome profile used by login and scraping. |
| `CHROME_PATH` | Optional path to Chrome when it is installed in a non-standard location. |
| `SCRAPE_PHOTOS` | Enables Google Maps photo collection when set to `true`. |
| `PHOTO_TABS` | Photo tabs to inspect, separated by `\|`. The default is `Menu\|By owner\|All\|Food & drink\|Vibe`; setting one value runs only that tab. |
| `PHOTO_MAX_PER_PLACE` | Fallback limit for a custom photo tab that does not have a specific limit below. |
| `PHOTO_LIMIT_MENU` | Maximum newest Menu photos saved per place; defaults to 8. |
| `PHOTO_LIMIT_BY_OWNER` | Maximum newest By owner photos saved per place; defaults to 4. |
| `PHOTO_LIMIT_ALL` | Maximum newest All photos saved per place; defaults to 30. |
| `PHOTO_LIMIT_FOOD_DRINK` | Maximum newest Food & drink photos saved per place; defaults to 8. |
| `PHOTO_LIMIT_VIBE` | Maximum newest Vibe photos saved per place; defaults to 3. |
| `PHOTO_SCAN_LIMIT` | Maximum gallery candidates inspected per tab before the newest photos are selected. |
| `PHOTO_SCROLL_ROUNDS` | Maximum photo-gallery scroll rounds before collection stops. |
| `PHOTO_DATE_BATCH_SIZE` | Number of dates collected in each short-lived browser page. The tested default 10 reduces page starts without exceeding memory. |
| `PHOTO_DATE_CONCURRENCY` | Simultaneous upload-date pages. Keep at 1 on the current laptop; 2 exceeded its memory limit. |
| `PHOTO_DATE_WAIT_MS` | Settle delay between upload-date photo transitions. The verified default is 300 ms. Increase it if dates become incomplete on a slower connection. |
| `PHOTO_PROBE_CONCURRENCY` | Simultaneous full-size image probes. The tested default is 2. |
| `PHOTO_CAPTURE_UPLOAD_DATE` | Enables upload-date lookup and defaults to `true`. When explicitly `false`, `uploadDate` is `null`. |
| `SCRAPE_REVIEWS` | Saves reviews in every main place record when `true`; defaults to `true`. |
| `REVIEW_MAX_PER_PLACE` | Maximum newest reviews saved per place; defaults to 50. |
| `REVIEW_SORT` | Main review order: `newest`, `relevant`, `highest`, or `lowest`; defaults to `newest`. |
| `REVIEW_SCROLL_ROUNDS` | Maximum review-panel scroll rounds in the main scrape. |
| `REVIEW_SCROLL_WAIT_MS` | Delay after each main review scroll, in milliseconds. |
| `SAFE_BATCH_SIZE` | Number of detail pages handled before safe mode restarts Chrome. |
| `SAFE_RESTART_DELAY_MS` | Delay between safe-mode Chrome batches. |
| `SAFE_MAX_CONSECUTIVE_FAILURES` | Number of consecutive failed batches allowed before safe mode stops. |
| `OUTPUT_DIR` | Main JSON, CSV, Excel, failure, and photo-list directory; defaults to `output/scraper`. |
| `CRAWLEE_STORAGE_DIR` | Safe-run queue and dataset directory; defaults to `storage`. |
| `MAX_REQUESTS_PER_CRAWL` | Internal per-process cap controlled by safe mode. Normally do not set it manually. |
| `CHAIN_CLASSIFICATION_CATALOG` | Malaysia brand-count catalog; defaults to `config/malaysia-chain-counts.json`. |
| `COLUMNS` | Kept at `200` so Windows does not truncate the process header Crawlee reads. |

### Photo-classification and analysis configuration

| Setting | Default | Meaning |
| --- | ---: | --- |
| `PHOTO_ANALYSIS_INPUT` | newest scraper run | Optional exact main JSON containing photo URLs. Leave empty for automatic newest-run selection. |
| `PHOTO_ANALYSIS_OUTPUT_DIR` | `output/photo-classification` | Root directory for timestamped classification runs. |
| `PHOTO_MENU_ANALYSIS_OUTPUT_DIR` | `output/photo-analysis` | Root for PaddleOCR, structured parsing, and menu-matching jobs. |
| `PHOTO_ANALYSIS_PLACE_LIMIT` | all | Empty or `all` processes every matching location; a positive number limits a test. |
| `PHOTO_ANALYSIS_PLACES` | empty | Optional `\|`-separated exact place names. |
| `PHOTO_ANALYSIS_MAX_PHOTOS_PER_PLACE` | `30` | Maximum photos analyzed per location. |
| `PHOTO_ANALYSIS_MODEL` | `Xenova/clip-vit-base-patch32` | Zero-shot image classifier. |
| `PHOTO_ANALYSIS_DTYPE` | `q8` | Quantized model type used to reduce memory. |
| `PHOTO_ANALYSIS_DEVICE` | `cpu` | Inference device; CPU is the validated setting. |
| `PHOTO_ANALYSIS_MODEL_CACHE` | `.cache/transformers` | Downloaded model cache. |
| `PHOTO_ANALYSIS_OCR_ENGINE` | `paddleocr` | OCR engine for new runs; use `tesseract` only for fallback or an older checkpoint. |
| `PHOTO_ANALYSIS_OCR_IMAGE_SIZE` | `1800` | Maximum dimension downloaded after a photo is classified as a menu. |
| `PHOTO_ANALYSIS_PADDLE_PYTHON` | `.venv-paddleocr/Scripts/python.exe` | Python executable created by `npm run setup:paddleocr`. |
| `PHOTO_ANALYSIS_PADDLE_MODEL_SIZE` | `small` | PP-OCRv6 `tiny`, `small`, or `medium` detection and recognition models. |
| `PHOTO_ANALYSIS_PADDLE_CPU_THREADS` | `4` | CPU threads available to the PaddleOCR worker. |
| `PHOTO_ANALYSIS_OCR_LANGUAGES` | `eng+msa` | Tesseract fallback languages. |
| `PHOTO_ANALYSIS_OCR_CACHE` | `.cache/tesseract` | Tesseract fallback language-data cache. |
| `PHOTO_ANALYSIS_IMAGE_SIZE` | `1280` | Maximum classification image dimension. |
| `PHOTO_ANALYSIS_REQUEST_TIMEOUT_MS` | `30000` | Photo download timeout in milliseconds. |
| `PHOTO_ANALYSIS_DELAY_MS` | `250` | Delay between photos. |
| `PHOTO_ANALYSIS_MIN_SCORE` | `0.42` | Lower top scores become `unknown`. |
| `PHOTO_ANALYSIS_MIN_MARGIN` | `0.08` | Narrow first-versus-second margins become `unknown`. |
| `PHOTO_ANALYSIS_LABELS` | `config/photo-analysis-labels.csv` | Manual category and optional OCR ground truth. |
| `PHOTO_LABEL_PORT` | `3789` | Local browser labeller port. |
| `PHOTO_LABEL_OPEN_BROWSER` | `true` | Automatically open the labelling interface. |
| `PHOTO_LABEL_INPUT` | newest completed run | Optional exact `photo-analysis.json` to label. |

`MAX_PLACES` is shared across all queries and areas. Discovery completes for every query/area combination first, then a deduplicated round-robin selection gives each combination a fair opportunity to contribute places. For example, `MAX_PLACES=100` means up to 100 total places, not 100 from every query or area.

Smaller districts normally provide better coverage than one broad Kuala Lumpur search. Increase `MAX_CANDIDATES_PER_AREA` if an area can provide more candidates and you want it to participate more deeply in the final selection.

## Running the scraper

For photo scraping or longer runs, use safe mode. It processes a small batch,
fully closes Chrome to release memory and the dedicated profile, then resumes
the same Crawlee queue automatically:

```powershell
npm run start:safe
```

If a safe run was interrupted by a shutdown, manual stop, or browser failure,
resume the existing queue without purging completed work:

```powershell
npm run resume:safe
```

### Safety stops and exit codes

The scraper distinguishes ordinary recoverable failures from conditions where
opening another Chrome process could make a Google block worse or produce false
`none` results.

- A normal Chrome crash, memory interruption, or transient request failure keeps
  the remaining queue available. Safe mode can restart Chrome and continue.
- Unusual-traffic pages, CAPTCHA, a signed-out required profile, or the configured
  consecutive-empty-menu threshold stop the run without reopening Chrome.
- The empty-menu streak and completed/failed place bookkeeping are preserved
  across safe-mode Chrome restarts.
- Completed records remain in the dataset. Known unprocessed inputs are written
  to `failed-restaurants.json` for that run, while their queue entries remain
  pending so `npm run resume:safe` can continue after the account or block is
  resolved.

Process exit codes are:

- `0`: completed normally;
- `1`: completed with one or more terminal place failures;
- `2`: safety stop requiring user action.

Every process prints a final `RUN_SUMMARY` JSON line containing the status,
counts, safety-stop reason, and output directory.

Safe mode defaults to four restaurant-detail requests per Chrome process. The
batch size, restart delay, and consecutive-failure limit can be configured with
`SAFE_BATCH_SIZE`, `SAFE_RESTART_DELAY_MS`, and
`SAFE_MAX_CONSECUTIVE_FAILURES` in `.env`.

Safe mode completes all query-and-area discovery first and stores every selected
detail URL in Crawlee's persistent queue. It then processes the queue in small
Chrome batches. A log such as `4/50` refers to the current Chrome process; it
does not cap the final output at four. Use the safe-run `handled` and `pending`
counts and the final length of that run's `json/restaurants.json` to confirm completion.

`npm run start:safe` creates a fresh queue for the current configuration.
`npm run resume:safe` continues the existing queue. Do not use resume for a new
query or area list.

Plain `npm start` runs the scraper in one process. Use it for short tests or a
single restaurant; it is not recommended for large photo-enabled runs:

```powershell
npm start
```

The provided `.env.example` uses `HEADLESS=true`. The visible-browser shortcut remains available for login checks and troubleshooting:

```powershell
npm run start:visible
```

Override settings for one PowerShell run:

```powershell
$env:QUERY = 'halal restaurants'
$env:AREAS = 'Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur'
$env:MAX_PLACES = '50'
npm start
```

Close that PowerShell window or remove the temporary variables afterward if you want later runs to use only `.env` again.

An exact-name query is useful for testing one restaurant:

```powershell
$env:QUERY = 'Yellow Fin Horse'
$env:AREAS = 'Kuala Lumpur'
$env:MAX_PLACES = '1'
npm start
```

Google may open an exact match directly instead of showing a search-results feed; the scraper supports both page types.

Direct Google Maps URLs can bypass discovery for focused retries:

```powershell
$env:PLACE_URLS = 'https://www.google.com/maps/place/...'
$env:MAX_PLACES = '1'
npm start
```

Direct input records use `area: "Direct input"`.

Google place IDs can also be supplied directly. Multiple IDs are separated by
`|`, just like `PLACE_URLS`:

```powershell
$env:PLACE_IDS = 'ChIJfirst...|ChIJsecond...'
npm start
```

`PLACE_URLS` accepts the Google Maps API URL form requested by the client:

```text
https://www.google.com/maps/search/?api=1&query=<name>&query_place_id=<ChIJ...>
```

For one place, pass either the ID or the full URL after `--`:

```powershell
npm run scrape:one -- "ChIJa1yDFxRJzDERfLtufF3j-VI"
```

This mode sets the place limit to one, skips area discovery, and writes a single
JSON object into the new run's `json/place.json`. Normal batch mode writes its
restaurant files into the same dated run structure.

## Output

The output root is grouped by pipeline so results are easy to locate:

| Folder | Contains |
| --- | --- |
| `output/scraper/<date>/<time>/` | Main place JSON/CSV/Excel, failures, flat photo list, and run information. |
| `output/photo-classification/<date>/<time>/` | CLIP category results, checkpoints, category labels, and evaluation. |
| `output/photo-analysis/<date>/<time>/` | One photo-menu job containing PaddleOCR, parsing, and matching stages. |

For example, a normal scraper run writes:

```text
output/scraper/2026-11-14/14-30-25/
  json/restaurants.json
  json/photo-list.json
  json/failed-restaurants.json
  csv/restaurants.csv
  csv/photo-list.csv
  xlsx/restaurants.xlsx
  other/run-summary.json
  other/safe-run.json
```

The date and time use the computer's local timezone. If two runs start in the
same second, a numeric suffix is added. Every safe-run Chrome batch reuses the
same folder, and `npm run resume:safe` reopens that preserved run.

Crawlee also keeps its local dataset under `storage/datasets/default/`. Nested fields such as `menu`, `openingHours`, `popularTimes`, `peakHours`, `about`, and `contact` are stored as JSON strings inside the CSV.

When Google Maps displays Popular times, `popularTimes` contains each displayed
hour for all seven days as a relative `busynessPercent`, plus daily and overall
peak and quietest periods. These percentages are Google's relative busyness
measure, not a count of people. Zero-percent readings remain in the hourly data,
but are excluded from quietest-period conclusions because Google may render zero
outside business hours. `peakHours` remains as a compact compatibility summary.

Photo records use `photoId`, `fullSizeImageUrl`, `tabs`, `uploadDate`, `width`,
and `height`. Videos are skipped. Each requested tab is ordered newest first
using Google's displayed upload date, then its own limit is applied. Duplicate
photos found in several tabs are merged, so one place can contain more than 30
unique photos across all five tabs. A successful tab can contain fewer than its
configured limit when Google exposes fewer photos. When upload-date collection
is explicitly disabled, `uploadDate` is intentionally `null`.

Every run also writes `json/photo-list.json` and `csv/photo-list.csv`. These are
flat reader inputs with one row per photo and source tab:
`placeId`, `shopName`, `photoId`, `tab`, `uploadDate`, and `fullSizeImageUrl`.
A photo present in multiple tabs has one row for each tab. See
`PHOTO_TOOLS_HANDOVER.md` for the short analysis and labelling handover.
For the newest result, regenerate them with `npm run export:photos`. Supply an
exact `json/restaurants.json` path after `--` to target an older run.

Every completed run also writes `restaurants.xlsx` while retaining
`restaurants.json` and `restaurants.csv`. The workbook separates client-readable
data into `Places`, `Menu`, `Photos`, `Reviews`, `Opening Hours`,
`Popular Times`, and `About` worksheets. To rebuild it from an existing result:

```powershell
npm run export:excel
```

To scrape only one photo tab for a supplied list of places, override
`PHOTO_TABS` for that PowerShell session:

```powershell
$env:PLACE_IDS = 'ChIJfirst...|ChIJsecond...'
$env:PHOTO_TABS = 'Menu'
npm run start:safe
```

### Main record fields

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string or `null` | Place heading displayed by Google Maps. |
| `placeId` | string or `null` | Google place ID beginning with `ChIJ`, extracted from the input or canonical URL. |
| `featureId` | string or `null` | Google Maps feature ID in `0x...:0x...` form. |
| `latitude` | number or `null` | Latitude from the canonical place URL. |
| `longitude` | number or `null` | Longitude from the canonical place URL. |
| `rating` | number or `null` | Displayed rating from 1 to 5. |
| `area` | string | Search area that contributed the selected place. |
| `category` | string or `null` | Displayed Google Maps business category. |
| `businessStatus` | string | `open`, `temporarily_closed`, or `permanently_closed`. |
| `brandSize` | string or `null` | Malaysia-only catalog classification. |
| `numberOfOutlets` | integer or `null` | Verified Malaysia outlet count from the catalog. |
| `address` | string or `null` | Displayed address. |
| `contact.phone` | string or `null` | Displayed phone number. |
| `contact.website` | string or `null` | Website linked by Google Maps. |
| `reviewCount` | integer or `null` | Displayed total review count. |
| `priceLevel` | string or `null` | Displayed per-person price range. |
| `openingHours` | array | Weekly day and hours rows. |
| `menu` | object or `null` | Structured Google Maps menu sections and dishes. |
| `menuScrape` | object | Typed-menu status, Menu-tab presence, item/category counts, attempts, and error. |
| `popularTimes` | object or `null` | Hourly relative busyness and derived peak/quiet periods. |
| `peakHours` | array | Compact compatibility summary derived from Popular times. |
| `query` | string | Search phrase that contributed the place. |
| `about` | object or `null` | Grouped attributes read from Google's About section. |
| `photos` | array or `null` | Photo metadata; `null` when collection is disabled. |
| `photoScrape` | object or `null` | Overall and per-tab photo collection status. |
| `reviews` | array or `null` | Review sentences; `null` when main review collection is disabled. |
| `reviewScrape` | object or `null` | Review-tab presence, target/count, sort validation, expansion diagnostics, attempts, and tri-state status. |
| `googleMapsUrl` | string | Canonical place URL. |
| `scrapedAt` | ISO timestamp | Time the record completed. |

Plus Code, top-level phone, and top-level website are not part of the current
output format. Phone and website remain grouped under `contact`.

### Expected JSON record

The following shortened example shows the complete top-level output structure.
Real records can contain seven Popular-times days, many menu sections, and the
merged photos selected under each configured tab limit.

```json
{
  "name": "Example Cafe",
  "placeId": "ChIJexample",
  "featureId": "0x31cc000000000000:0x1234000000000000",
  "latitude": 3.1573621,
  "longitude": 101.6998564,
  "rating": 4.5,
  "area": "Kuala Lumpur City Centre",
  "category": "Cafe",
  "businessStatus": "open",
  "brandSize": "small chain",
  "numberOfOutlets": 2,
  "address": "1 Example Road, Kuala Lumpur",
  "contact": {
    "phone": "03-1234 5678",
    "website": "https://example.com"
  },
  "reviewCount": 320,
  "priceLevel": "RM 20–40 per person",
  "openingHours": [
    { "day": "Friday", "hours": "10 am–10 pm" }
  ],
  "menu": {
    "source": "google_maps",
    "sections": [
      {
        "name": "Drinks",
        "items": [
          {
            "name": "Iced Latte",
            "description": "Espresso with fresh milk",
            "priceText": "RM 12.00",
            "priceValue": 12,
            "currency": "MYR"
          }
        ]
      }
    ]
  },
  "menuScrape": {
    "status": "success",
    "tabExists": true,
    "itemCount": 1,
    "categoryCount": 1,
    "attempts": 1,
    "error": null
  },
  "popularTimes": {
    "source": "google_maps",
    "unit": "relative_busyness_percent",
    "days": [
      {
        "day": "Friday",
        "hours": [
          { "time": "4 pm", "hour": 16, "minute": 0, "busynessPercent": 30, "label": "30% busy at 4 pm." },
          { "time": "5 pm", "hour": 17, "minute": 0, "busynessPercent": 45, "label": "45% busy at 5 pm." }
        ],
        "peak": [
          { "time": "5 pm", "hour": 17, "minute": 0, "busynessPercent": 45 }
        ],
        "quietest": [
          { "time": "4 pm", "hour": 16, "minute": 0, "busynessPercent": 30 }
        ]
      }
    ],
    "overallPeak": [
      { "day": "Saturday", "time": "1 pm", "hour": 13, "minute": 0, "busynessPercent": 100 }
    ],
    "overallQuietest": [
      { "day": "Friday", "time": "4 pm", "hour": 16, "minute": 0, "busynessPercent": 30 }
    ]
  },
  "peakHours": ["Saturday: 100% busy at 1 pm."],
  "query": "cafes",
  "about": {
    "Service options": [
      { "name": "Delivery", "available": true },
      { "name": "Takeaway", "available": true },
      { "name": "Dine-in", "available": true }
    ]
  },
  "photos": [
    {
      "photoId": "google-photo-id",
      "sourceImageUrl": "https://lh3.googleusercontent.com/example=w203-h152-k-no",
      "photoIndex": 0,
      "discoverySource": "dom",
      "looksLikeVideo": false,
      "tabs": ["Menu", "All"],
      "uploadDate": { "text": "May 2025", "year": 2025, "month": 5, "day": null },
      "fullSizeImageUrl": "https://lh3.googleusercontent.com/example=s0",
      "width": 4000,
      "height": 3000
    }
  ],
  "photoScrape": {
    "status": "success",
    "uploadDateCaptureEnabled": true,
    "photoCount": 42,
    "tabs": {
      "Menu": { "status": "success", "attempts": 1, "requestedLimit": 8, "discoveredPhotoCount": 24, "photoCount": 8, "uploadDatesCaptured": 8, "metadataStatus": "success", "error": null, "metadataError": null },
      "By owner": { "status": "none", "attempts": 2, "requestedLimit": 4, "discoveredPhotoCount": 0, "photoCount": 0, "uploadDatesCaptured": 0, "metadataStatus": "none", "error": null, "metadataError": null },
      "All": { "status": "success", "attempts": 1, "requestedLimit": 30, "discoveredPhotoCount": 30, "photoCount": 30, "uploadDatesCaptured": 30, "metadataStatus": "success", "error": null, "metadataError": null },
      "Food & drink": { "status": "success", "attempts": 1, "requestedLimit": 8, "discoveredPhotoCount": 20, "photoCount": 8, "uploadDatesCaptured": 8, "metadataStatus": "success", "error": null, "metadataError": null },
      "Vibe": { "status": "success", "attempts": 1, "requestedLimit": 3, "discoveredPhotoCount": 15, "photoCount": 3, "uploadDatesCaptured": 3, "metadataStatus": "success", "error": null, "metadataError": null }
    },
    "requestAttempts": 1
  },
  "reviews": [
    {
      "reviewId": "google-review-id",
      "rating": 5,
      "text": "Good coffee and a quiet atmosphere.",
      "publishedText": "3 hours ago",
      "likes": null
    }
  ],
  "reviewScrape": {
    "status": "success",
    "tabExists": true,
    "attempts": 1,
    "availableReviewCount": 320,
    "requestedReviewCount": 50,
    "scrapedReviewCount": 50,
    "targetMet": true,
    "sort": "newest",
    "newestOrderViolations": 0,
    "unexpandedReviewCount": 0,
    "reviewerDetailsCollected": false,
    "ownerResponsesCollected": false,
    "error": null
  },
  "googleMapsUrl": "https://www.google.com/maps/place/Example",
  "scrapedAt": "2026-10-17T02:05:36.979Z"
}
```

When Google does not provide typed menu items or a Popular-times chart, the
corresponding data field is `null`. `menuScrape.status` is `none` when the Menu
tab is absent or a loaded Menu region contains no typed dishes; `tabExists`
distinguishes those cases. A Menu tab that does not load after retry uses
`menuScrape.status: "failed"`. When photo scraping is disabled, `photos` and
`photoScrape` are `null`; when it is enabled but no photos are found, `photos`
is an empty array. A failed photo page uses `photoScrape.status: "failed"`; a
confirmed tab with no photos uses `"none"`. When review collection is disabled,
`reviews` and `reviewScrape` are `null`. A confirmed place with no reviews uses
`reviewScrape.status: "none"`; a page, sort, expansion, or collection failure
uses `"failed"` and never silently becomes `"none"`.

Photo status meanings are deliberately different:

- `success`: photo metadata was collected from the available requested tabs;
- `partial`: useful photo data was collected but not every requested tab
  completed successfully;
- `none`: the photo interface or tab loaded, was checked again, and contained no
  photos;
- `failed`: the interface did not load or another blocking error remained after
  retries.

Each tab records `status`, `attempts`, `requestedLimit`,
`discoveredPhotoCount`, `photoCount`, `uploadDatesCaptured`, `metadataStatus`,
`fullSizeMetadataStatus`, `error`, `metadataError`, and failed metadata IDs.
Missing upload dates and failed full-size image probes receive one focused retry;
remaining failures make the affected tab and overall photo result `partial`.
`photoScrape.requestAttempts` records full place-page attempts. Duplicate photos
found across the five configured tabs are merged and their `tabs` values are
combined. The scraper saves URLs and metadata rather than downloading permanent
image files.

Progress logs include:

- discovered candidate totals for each area
- selected totals for each area
- per-restaurant scrape duration
- rating, review count, contact details, and menu item count
- failures and retries
- total elapsed time and exported record count

Crawlee purges its default local storage at the beginning of a normal run. Copy earlier output or storage elsewhere before starting if you need to preserve it.

In safe mode, every Chrome process atomically rewrites the aggregated restaurant
JSON and CSV from Crawlee's persistent dataset. Per-process success logs can
therefore describe one batch while the files already contain earlier batches.
`failed-restaurants.json` contains failures observed by the process that most
recently exported it. Keep terminal logs and `storage/` when a complete
multi-process failure audit is required.

## Latest verified run

On 31 October 2026, the complete headless one-place path was verified with the
client-supported `query_place_id` URL for Slow Wood Coffee Mont Kiara. The
record contained:

- place ID, feature ID, latitude, longitude, and `businessStatus`;
- 59 typed menu items across 19 sections with `menuScrape.status: "success"`;
- 37 unique photos across all five requested tabs;
- upload dates, full-size URLs, width, and height for all 37 photos, with no
  failed photo metadata;
- 50 newest reviews with zero order violations, zero unexpanded review controls,
  no reviewer details, and no owner responses; and
- `success` for menu, photos, and reviews.

After review/photo-date overlap and removal of a duplicated date-transition
wait, the final current-config run completed the place in 3 minutes 15 seconds
and the whole command—including Chrome startup and export—in 3 minutes 18
seconds. This meets the client target in the verified run. Earlier runs varied
up to 4 minutes 31 seconds when Google required a second review attempt and
some galleries responded more slowly, so a strict wall-time guarantee is still
not possible against the live Google interface.

The main output generated on 17 October 2026 was checked successfully:

- 50 unique places exported and 0 failed requests
- 26 results from `cafes` and 24 from `drink`
- 42 places with structured menus, containing 2,836 dishes
- 41 places with valid Popular-times charts, containing 5,050 hourly readings
- 1,496 unique photos, all with photo IDs, full-size URLs, tab information, width, and height
- CSV contains one header and 50 balanced, valid data rows

The record timestamps span approximately 1 hour 55 minutes. Discovery and
startup time may make the complete command runtime slightly longer.

The earlier independent review test collected 50 reviews from each of four
locations: 200 reviews in total, four successful place results, no partial or
failed results, and approximately 1 minute 30 seconds total runtime. Main-record
review integration has since been verified separately with 50 reviews in 56
seconds when photos were disabled.

The completed photo-analysis run on 18 October 2026 processed all 50 locations
and 1,496 photos in approximately 26 minutes. All 1,496 images succeeded and
were manually labelled. Evaluation produced 76.1% accuracy, 64.1% macro
precision, 76.0% macro recall, and 66.1% macro F1. The detailed category results
are documented in the photo-analysis section below.

## Known limitations

- Google Maps is a dynamic, frequently changing JavaScript application. Selectors may need maintenance when Google changes its interface.
- Menus are loaded lazily and can be virtualized. The scraper scrolls each category and waits for content, but Google may occasionally omit a dish during a run because of delayed loading, network timing, experiments, or rate limiting. Running the affected restaurant again may return the missing dish.
- Only genuine structured dishes from the Google Maps Menu tab are collected. Menu photos, external restaurant websites, PDFs, Facebook pages, and delivery platforms are not interpreted.
- Some places publish dish names without descriptions or prices. Missing values remain `null`; when Google exposes the displayed price in the description element without separate descriptive text, the scraper keeps `description` as `null`.
- `priceText` preserves Google's displayed value. `priceValue` is parsed only from an explicit single price. Price ranges and missing prices produce a `null` numeric value. Currency is recorded only when Google displays an explicit symbol or code.
- Ratings and per-person price ranges are collected only when Google displays them on the place page.
- Popular-times data is `null` when Google does not publish the chart or the chart does not load. It represents relative busyness percentages, not actual visitor counts.
- `MAX_PLACES` is an upper limit, not a guarantee. Google controls how many results are available for a query and area.
- The scraper uses low concurrency and does not bypass CAPTCHAs or implement aggressive anti-bot evasion.

For production or commercial integrations, consider the official Google Places API. Confirm that your collection and use comply with Google Maps terms and applicable privacy and data-protection laws.

## Review scraping

The main scraper now writes `reviews` and `reviewScrape` into every place record
when `SCRAPE_REVIEWS=true`. The default target is 50 reviews sorted newest-first.
Review collection is overlapped with the first photo upload-date batch without
increasing the existing two-page ceiling: the main page handles reviews while
one short-lived page handles dates.

Main review statuses are deliberately limited to:

- `success`: the complete requested target was collected and validated;
- `none`: the Reviews interface loaded and Google confirmed no reviews; and
- `failed`: the page, Reviews section, sort, text expansion, or requested count
  did not complete after two attempts.

`none` is never used for a page that failed to load. Reviewer names, profile
details, profile URLs/photos, histories, and owner responses are not collected.

### Review privacy and item format

Reviewer names, profile URLs, profile photos, review histories, and owner
responses are intentionally not collected. Each saved review contains:

```json
{
  "reviewId": "google-review-id",
  "rating": 5,
  "text": "Good food, good people.",
  "publishedText": "3 hours ago",
  "likes": null
}
```

`publishedText` preserves Google's relative text and is not converted into an
invented date. `likes` remains `null` when Maps does not display a parseable
count.

### Review collection and validation

The target for a place is
`min(REVIEW_MAX_PER_PLACE, availableReviewCount)` when the main record has a
valid review count. Each place is attempted twice. The requested sort must be
confirmed when more than one review is expected. `newest` also receives a
relative-date order check with a small allowance for ambiguous positions.

Reviews are deduplicated by `reviewId`. If an ID is unavailable, rating,
published text, and review text form the fallback identity. Visible truncated
reviews are expanded before saving. If selected text remains expandable, the
attempt fails instead of silently saving incomplete text.

The integrated review stage's per-place statuses mean:

- `success`: the target number of reviews was collected;
- `partial`: at least one review was collected, but fewer than the target;
- `none`: Google explicitly showed that the place has no reviews;
- `failed`: the page, Reviews section, requested sort, text expansion, or
  collection did not complete after two attempts.

Diagnostics include `attempts`, `stalledScrolls`, `newestOrderViolations`,
`unexpandedReviewCount`, `error`, `scrapedAt`, and `elapsedMs`.

## Malaysia chain-size classification

The main scraper loads the Malaysia brand catalog once at startup and writes
`brandSize` and `numberOfOutlets` directly into every JSON and CSV record. It
does not open additional Google Maps pages, so the classification adds only a
negligible local lookup. The categories use the number of locations in
Malaysia only:

| Malaysia locations | Category |
| ---: | --- |
| 1 | `independent` |
| 2–5 | `small chain` |
| 6–15 | `mid chain` |
| 16–40 | `large chain` |
| 41+ | `huge chain` |

Add verified or client-provided branch counts to
`config/malaysia-chain-counts.json`. Matching can use exact names, explicit
branch-name prefixes, or website domains:

```json
{
  "scope": "Malaysia",
  "brands": [
    {
      "brand": "Example Cafe",
      "aliases": ["Example Coffee"],
      "namePrefixes": ["Example Cafe", "Example Coffee"],
      "websiteDomains": ["example.cafe"],
      "malaysiaLocationCount": 4,
      "evidence": [
        {
          "type": "official_store_locator",
          "url": "https://example.cafe/locations",
          "checkedAt": "2026-10-17"
        }
      ]
    }
  ]
}
```

The example above is illustrative; replace it with real brands and evidence.
Matching priority is website domain, exact normalized brand name or alias, then
an explicitly configured name prefix. An unmatched or ambiguous record stays
`null` rather than being guessed.

The repository's current catalog contains an empty `brands` array. Therefore
`brandSize` and `numberOfOutlets` remain `null` until verified Malaysia outlet
counts are added. The number of places found in one scrape is never treated as
the Malaysia outlet total.

The normal `npm start` and `npm run start:safe` commands classify records
automatically. If the national count cannot be matched, both classification
values remain `null`; the scraper never treats the number seen in the current
run as the Malaysia outlet total.

```json
{
  "brandSize": "small chain",
  "numberOfOutlets": 2
}
```

## Independent photo analysis

`src/analyze-photos.js` reads photo URLs from the newest scraper run unless
`PHOTO_ANALYSIS_INPUT` names an exact JSON. It does not launch Google Maps and
does not modify the main scraper or `restaurants.json`. Run it after scraping has finished:

```powershell
npm run analyze:photos
```

By default, the command analyzes every restaurant with photos in the input
JSON, up to 30 photos each, one image at a time. Set
`PHOTO_ANALYSIS_PLACE_LIMIT` to a positive number only for a smaller test. It
uses quantized CLIP to classify successfully loaded images as
`menu`, `food`, `interior`, or `unknown`. Only menu images are passed to the
English and Malay OCR worker. Original full-size URLs remain in the output,
but resized copies are used during analysis to control memory use.

Each run creates `output/photo-classification/<date>/<time>/` with:

- `json/photo-analysis.json`: combined restaurant results, individual image scores,
  OCR text, and run settings
- `json/evaluation.json`: precision, recall, F1, accuracy, and confusion matrix when
  manual labels are available
- `csv/photo-labels-template.csv`: a review sheet for adding correct categories
- `xlsx/`: generated quick-view workbooks when requested
- `other/`: temporary OCR state and other non-tabular artifacts

`unknown` means the image loaded and was analyzed but the result was unclear.
`failed` means the image could not be downloaded, decoded, or processed. CLIP
confidence scores rank the configured prompts; they are not calibrated
probabilities.

If a run stops, resume the newest checkpoint with:

```powershell
npm run analyze:photos:resume
```

To measure precision, copy a generated `photo-labels-template.csv` to
`config/photo-analysis-labels.csv`, fill `actualCategory` with only `menu`,
`food`, `interior`, or `unknown`, then run:

```powershell
npm run analyze:photos:evaluate
```

That command recalculates metrics without downloading photos or loading the
model again. `expectedOcrText` is optional; when supplied for menu photos, the
report also calculates mean OCR character accuracy. Until manual labels exist,
precision and the other validation metrics are deliberately `null`.

### Browser photo labelling

Use the local browser interface to review every analyzed image and build the
manual labels file:

```powershell
npm run label:photos
```

It opens the newest completed photo-analysis run in the default browser at
`http://127.0.0.1:3789`. Choose the actual category with the buttons or the
number keys: `1` menu, `2` food, `3` interior, and `4` unknown. Each choice is
immediately saved to `config/photo-analysis-labels.csv`, and the next
unlabelled photo is displayed. Stop with `Ctrl+C`; the next run resumes from
the saved labels.

The interface can filter all photos, low-confidence results, predicted menu
photos, or disagreements. It also shows model scores, Google source tabs, OCR
text, and the full-size image link. Corrected menu transcription is optional.
After labelling a useful sample or the full set, run:

```powershell
npm run analyze:photos:evaluate
```

### Classification method and fields

The analyzer downloads a resized copy of each full-size image URL, normalizes it
with Sharp, and sends it to quantized CLIP zero-shot classification. Prompt
groups represent:

- `menu`: printed menus, menu boards, and photographed menu pages;
- `food`: prepared food, meals, desserts, coffee, and drinks;
- `interior`: dining rooms, seating, counters, and interior decor;
- `unknown`: exteriors, people, logos, receipts, screenshots, unrelated objects,
  or uncertain results.

Scores for prompts in the same group are added. The highest group becomes
`modelTopCategory`. The final `category` becomes `unknown` when the model
selects unknown, the top score is below `PHOTO_ANALYSIS_MIN_SCORE`, or the
top-versus-second margin is below `PHOTO_ANALYSIS_MIN_MARGIN`.

Every successful image includes `modelTopCategory`, `category`, `confidence`,
`confidenceLevel`, `margin`, `categoryScores`, `topPrompt`, and
`classificationReason`. CLIP confidence ranks the configured prompts; it is not
a calibrated probability.

`analysisStatus: "failed"` means the URL was unavailable, timed out, returned a
non-image response, was too large, could not be decoded, or failed during model
processing. `category: "unknown"` means the image loaded and was analyzed, but
the result was unknown or below the configured thresholds.

### OCR method and status

Only images whose automatic final category is `menu` are passed to OCR. New
runs use one persistent PaddleOCR worker with the PP-OCRv6 small models. The
worker preserves text boxes, polygons, confidence and conservative price
candidates. A separate image copy up to 1800 pixels is downloaded only for menu
photos. Set `PHOTO_ANALYSIS_OCR_ENGINE=tesseract` to reproduce the older
grayscale/normalized Tesseract path.

- `ocr.status: "success"`: OCR returned non-empty text.
- `ocr.status: "none"`: OCR ran but returned no usable text.
- `ocr.status: "failed"`: OCR produced an error.
- `ocr: null`: OCR was not attempted because the automatic category was not
  `menu`.

New PaddleOCR records also contain `ocr.engine`, `ocr.modelSize`, positioned
`ocr.lines`, `ocr.priceCandidates`, and `ocr.elapsedSeconds`. Existing
Tesseract result folders are not rewritten or deleted. A resumed checkpoint
must use the same OCR engine with which it started, preventing mixed results.

Manual category corrections do not retroactively run OCR. An actual menu photo
that CLIP predicted as food, interior, or unknown still has no OCR result unless
the analyzer logic or thresholds are changed and the photos are analyzed again.

### Optional PaddleOCR menu-photo runner

`src/paddleocr-menu.py` serves both as the persistent PaddleOCR worker used by
`src/analyze-photos.js` and as an independent evaluation path for folders of
menu photos. It does not modify the main scrape output. Existing Tesseract
results and the 1,496-photo evaluation remain reproducible by selecting the
Tesseract fallback engine.

After the one-time setup, run one image or every supported image in a folder:

```powershell
npm run setup:paddleocr
npm run recon:paddleocr -- "C:\path\to\menu-photos"
```

Useful optional arguments are:

```powershell
npm run recon:paddleocr -- "C:\path\to\photos" `
  --output-dir "output\photo-analysis\<date>\<time>\paddleocr" `
  --model-size small `
  --save-visualizations
```

The runner uses the CPU-oriented PP-OCRv6 small detection and recognition
models by default. Windows MKLDNN is deliberately disabled because the tested
PaddlePaddle 3.3.1 build failed during PP-OCRv6 inference with it enabled.

Each `paddleocr-analysis.json` contains:

- per-image `success`, `none`, or `failed` status and elapsed time;
- ordered text lines with confidence, bounding box, and polygon;
- combined raw OCR text; and
- conservative price candidates with source line, confidence, box, displayed
  text, numeric value, and currency only when `RM` or `MYR` was explicit.

Numeric-only price candidates intentionally retain `currency: null`; the runner
never guesses currency. These candidates are not yet structured menu dishes and
must be paired with nearby names using the saved coordinates. Candidate count is
also not an accuracy measurement: correct, wrong, and missed prices require
human-verified ground truth.

On the 20-photo test set prepared on 10 November 2026, the runner completed
20/20 images with no failures. It recognized 1,546 text lines and emitted 480
price candidates. OCR inference took 280.329 seconds in total, averaging 14.016
seconds per photo with a 12.779-second median. The complete command took 361.845
seconds including model startup, output writing, and visualization overhead.
This is an observed benchmark, not a guaranteed runtime or price-accuracy score.

### Structured menu-photo parsing

`src/parse-menu-ocr.py` converts a completed `paddleocr-analysis.json` into
structured menu candidates without changing the main scraper or photo analyzer.
Layout geometry is the primary signal: prices are treated as anchors, price
columns are detected, and candidate names must align within the same column.
Vertically stacked product cards use a stricter left-edge alignment rule.

Fuzzy matching is not used to decide which price belongs to an item. It is only
an optional validation step against a supplied typed-menu catalog, and the raw
OCR name is always preserved. The parser never fills a missing price or currency
and retains ambiguous or unpaired evidence for review.

Run the parser on a PaddleOCR output:

```powershell
npm run parse:menu-ocr -- `
  "output\photo-analysis\<date>\<time>\paddleocr\json\paddleocr-analysis.json"
```

When the input follows the standard layout, the parser automatically writes to
the same job under `menu-parsing/json`, `menu-parsing/csv`, and the other type
folders. `--output-dir` is only needed for a custom stage location.

Optional typed-menu validation uses the format in
`config/menu-ocr-typed-menu.example.json`:

```powershell
npm run parse:menu-ocr -- "<paddleocr-analysis.json>" `
  --typed-menu "config\my-typed-menu.json"
```

Human-verified evaluation uses the generated `ground-truth-template.json` or
the format in `config/menu-ocr-ground-truth.example.json`:

```powershell
npm run parse:menu-ocr -- "<paddleocr-analysis.json>" `
  --ground-truth "config\menu-ocr-ground-truth.json"
```

Each timestamped parser output contains:

- `structured-menu.json`: full items, multi-price variants, confidence, status,
  source line indexes, boxes, optional typed-menu matches, and image summaries;
- `structured-menu.csv`: one reader-friendly row per structured price;
- `ambiguous-items.json`: plausible pairings whose top alternatives were too
  close to call safely;
- `unpaired-lines.json`: price and text evidence that was not paired reliably;
- `evaluation.json`: correct, wrong, and missed price/pair metrics when verified
  ground truth is supplied; and
- `ground-truth-template.json`: empty human-verification template. Never copy
  predictions into it without checking the source photo.

Item fields include `section`, `name`, `description`, the single-price fields,
`prices[]` for variants, `status`, confidence, an optional `typedMenuMatch`, and
evidence line indexes. Single-price fields stay `null` when multiple prices are
shown rather than choosing one arbitrarily.

On the current 20-photo baseline, the conservative parser produced 345 item
candidates, marked 20 ambiguous, and retained 45 price lines as unpaired. These
figures measure parser coverage only. Accuracy remains `not_evaluated` until the
20 source photos have human-verified expected prices and name-price pairs.

### Categorizing unpaired menu prices

Run the local review interface after parsing:

```powershell
npm run label:menu-ocr
```

It selects the newest `menu-parsing/json/structured-menu.json` under
`output/photo-analysis`, opens `http://127.0.0.1:3792`, and shows the source
photo with the unresolved OCR line highlighted. You can classify a line as an
item price, price variant, add-on price, bundle price, not a price, duplicate,
unreadable, or unknown. Any category that creates menu data requires a manually
verified item name, displayed price text, and numeric price. Currency can remain
empty and is never inferred.

Each choice is saved atomically to
`config/menu-ocr-unpaired-labels.json`. Rerun the parser to apply the reviewed
evidence:

```powershell
npm run parse:menu-ocr -- "<paddleocr-analysis.json>" `
  --unpaired-labels "config\menu-ocr-unpaired-labels.json" `
  --output-dir "output\photo-analysis\<date>\<time>\menu-parsing"
```

Verified item, variant, add-on, and bundle labels are merged into the structured
output with `humanVerified: true` and confidence `1.0`. `not_a_price` and
`duplicate` resolve the evidence without creating an item. `unreadable` and
`unknown` remain unresolved. The original OCR line and the complete review label
are retained for audit.

### Menu matching and comparison report

The matcher is an independent stage. It does not change the scraper, classifier,
PaddleOCR worker, or structured menu parser. It compares Google typed-menu
offers from `restaurants.json` with verified or parser-produced offers from
`structured-menu.json`.

First create an exact image map. The command joins saved photo IDs and never
links a photo by restaurant-name similarity:

```powershell
npm run build:photo-map -- `
  --selection "<evaluation-selection.json>" `
  --photo-list "output\scraper\<date>\<time>\json\photo-list.json" `
  --output "output\photo-analysis\<date>\<time>\menu-parsing\csv\photo-map.csv"
```

Future inputs can instead put `placeId` and `photoId` directly on each
structured image, or use the file convention `<placeId>__<photoId>.jpg`. Link
priority is structured metadata, photo-map CSV, then the exact filename
convention. Unresolved images are reported and are never assigned by name.

Run the matcher:

```powershell
npm run match:menus -- `
  --restaurants "output\scraper\<date>\<time>\json\restaurants.json" `
  --structured "output\photo-analysis\<date>\<time>\menu-parsing\json\structured-menu.json" `
  --photo-map "output\photo-analysis\<date>\<time>\menu-parsing\csv\photo-map.csv"
```

The matcher recognizes the structured input's job and writes into that same
job's `menu-matching` stage unless `--output-dir` is supplied.

The default thresholds in `config/menu-matching.json` are `0.90` for an
accepted name and `0.75` for the review band. Variant tokens such as hot, iced,
and sizes are compared separately. Only the verified synonym `ais → iced` is
enabled initially. Matching is deterministic and one-to-one. A close
alternative, ambiguous OCR pairing, unlabelled multi-price item, missing/tied
photo dates, or conflicting prices caps the result at `REVIEW`.

The matcher never fills missing prices or currencies. Numeric prices can be
compared when one currency is absent, but `currencyCompared` remains false.
Several unlabelled photo prices remain non-comparable instead of choosing one.
When the same offer occurs in several photos, the newest determinable upload
date is used; all other copies remain in `otherPhotoPrices`. Missing or tied
dates are explicitly reviewed rather than treated as newest.

Outputs are written atomically:

- `menu-matches.json`: settings, place and item statuses, price comparisons,
  evidence, estimated metrics, and optional measured evaluation;
- `menu-matches.csv`: one flat row per comparison result; and
- `unlinked-images.json`: every structured image that lacked an exact link.

Item statuses are `MATCH`, `PRICE_DIFF`, `PRICE_NOT_COMPARABLE`, `REVIEW`,
`ONLY_GOOGLE`, and `ONLY_PHOTO`. Place statuses preserve
`NO_GOOGLE_MENU`, `GOOGLE_MENU_FAILED`, and `NO_MENU_PHOTOS` separately from a
successful comparison. Provide human-labelled data matching
`config/menu-match-ground-truth.example.json` with `--ground-truth` to add
measured precision, recall, F1, price-verdict accuracy, and a threshold sweep.
Without it, coverage and agreement figures are labelled estimated.

Create the reader-facing workbook:

```powershell
npm run export:report -- "output\photo-analysis\<date>\<time>\menu-matching\json\menu-matches.json"
```

This writes `menu-matching/xlsx/menu-check.xlsx` in the same job with Summary, Items, Review,
Photos, Metrics, and Info sheets. Review rows contain an Excel dropdown for
Accept, Reject, or Correct plus manual correction fields. These decisions are
notes only in this version and are not applied back automatically.

### Checkpoint and output details

After each restaurant, the analyzer updates
`photo-analysis.partial.json`. `npm run analyze:photos:resume` selects the newest
incomplete folder and skips restaurant keys already present. Starting
`npm run analyze:photos` without resume creates a new timestamped folder.

`photo-analysis.json` contains:

- run status, timestamps, input path, and effective settings;
- overall restaurant, image, failure, predicted category, and OCR counts;
- the current evaluation object;
- a summary for each restaurant; and
- every image's photo ID, original and resized URL, original size, source tabs,
  download and analyzed dimensions, model results, OCR result, and error.

Restaurant summaries contain photo totals, analyzed and failed counts, predicted
category totals, average confidence, low-confidence count, elapsed milliseconds,
and `menuOcr`. `menuOcr.texts` links OCR text to individual photo IDs, while
`menuOcr.combinedText` joins every successful menu OCR result for the restaurant.

`evaluation.json` contains status, label path, labelled-image count, accuracy,
macro precision, macro recall, macro F1, per-category support and metrics,
confusion matrix, and optional OCR character accuracy.

The current verified folder also contains
`photo-analysis-quick-view.xlsx`. It has an `Images` sheet and a `Menu OCR`
sheet, but it was produced as a one-off export and is not automatically created
by `npm run analyze:photos`.

### Browser labeller controls and safe saving

The labeller uses the newest completed analysis unless `PHOTO_LABEL_INPUT`
points to a specific JSON file. The default address is
`http://127.0.0.1:3789`.

Available views are unlabelled photos, all photos, low-confidence photos,
predicted menu photos, and label disagreements. A restaurant-name search can be
combined with each filter. The page displays the image, source tab, dimensions,
model prediction, per-category scores, confidence, OCR status, OCR confidence,
OCR text, and full-size image link.

Keyboard shortcuts are:

- `1`: menu
- `2`: food
- `3`: interior
- `4`: unknown
- left arrow: previous
- right arrow: next
- `S`: skip

Choosing a category autosaves and advances. `Copy to expected` copies extracted
OCR into the editable expected-text field. Correct that text before saving when
OCR character accuracy is required. `Clear label` removes the current ground
truth. `Download labels CSV` exports all current labels.

Labels are saved atomically to `config/photo-analysis-labels.csv`. Existing
labels resume when the server restarts. Windows file-lock retries and save-queue
recovery prevent one transient error from breaking later saves. Keep the CSV
closed in Excel while labelling. Stop the server with `Ctrl+C`; it waits for the
active save before closing.

### Evaluation definitions

Evaluation-only mode reads the newest completed analysis and the configured
labels. It does not download images, load CLIP, run OCR, or rewrite the generated
label template. It updates `evaluation.json` and the evaluation object inside
`photo-analysis.json`.

Metrics use only valid manual labels whose photo IDs exist in that analysis:

- accuracy is all correct predictions divided by all labelled predictions;
- precision is the correct predictions for a category divided by everything
  predicted as that category;
- recall is the correct predictions for a category divided by all actual
  labelled examples of that category;
- F1 is the harmonic mean of precision and recall;
- macro metrics are unweighted means over categories with labelled support;
- the confusion matrix uses actual categories as rows and predicted categories
  as columns.

OCR character accuracy is calculated only for labels that have both
`expectedOcrText` and extracted OCR text. It compares normalized expected and
recognized strings using character edit distance. Category labels alone cannot
produce an OCR accuracy score.

### Current verified photo evaluation

All 1,496 analyzed images were manually labelled:

| Actual category | Labelled images | Precision | Recall | F1 |
| --- | ---: | ---: | ---: | ---: |
| Menu | 86 | 32.9% | 90.7% | 48.3% |
| Food | 854 | 97.4% | 73.8% | 83.9% |
| Interior | 393 | 85.5% | 88.5% | 87.0% |
| Unknown | 163 | 40.5% | 50.9% | 45.1% |

Overall accuracy is 76.1%, macro precision is 64.1%, macro recall is 76.0%,
and macro F1 is 66.1%.

The automatic model predicted 237 menu, 647 food, 407 interior, and 205 unknown
images. It correctly identified 78 of the 86 actual menu photos, giving high
menu recall. However, 159 non-menu images were predicted as menu, producing low
menu precision. The model is useful for finding menu candidates but still needs
human confirmation.

OCR ran on the 237 automatically predicted menu images. It returned non-empty
text for 235 and empty text for 2. The other 1,259 images were not sent to OCR.
OCR character accuracy is currently `not_evaluated` because no manually
corrected `expectedOcrText` values were supplied.

### Checking analyzed OCR text

In `photo-analysis.json`, inspect:

```text
restaurants[].images[].ocr.text
restaurants[].menuOcr.texts[]
restaurants[].menuOcr.combinedText
```

In the current `photo-analysis-quick-view.xlsx`:

- `Menu OCR`, column H contains OCR text for predicted menu images;
- `Images`, column N contains OCR status;
- `Images`, column O contains OCR confidence;
- `Images`, column P contains OCR text; and
- the full-size URL allows direct comparison with the source image.

Empty OCR text does not prove an image contains no visible text. It means the
current preprocessing and OCR configuration returned no usable text.

## Runtime and hardware expectations

Runtime depends on Google Maps response time, result depth, menu size,
Popular-times availability, photo tabs, photo count, review loading, network
speed, RAM pressure, CPU speed, caches, and retries.

| Stage | Verified workload | Observed time |
| --- | --- | ---: |
| Main safe scrape | 50 locations and 1,496 photos | about 1 h 55 min |
| Complete one-place main path | 59 dishes, 37 dated photos, 50 reviews | verified command 3m 18s; slower retry run 4m 31s |
| Main review-only integration | 1 location, 50 newest reviews | 56 sec |
| Review test | 4 locations with 50 reviews each | about 1 min 30 sec |
| Photo analysis | 50 locations and 1,496 photos | about 26 min |

At the verified main-scraper rate, 100 locations are roughly 3.8 hours and
1,000 locations roughly 38 hours. These are planning estimates, not guarantees;
large runs can take longer because of rate limiting, retries, network variation,
and process restarts.

Lowering `SAFE_BATCH_SIZE` reduces peak Chrome memory but adds restart overhead.
Increasing scroll or analysis delays can help slow connections but increases
runtime. Main review collection overlaps with the first photo-date batch. A
second review attempt or slower Google gallery can still push a complete place
over four minutes. The final benchmark briefly reached 95–96% of Crawlee's
available-memory allowance during review/date overlap but recovered without a
crash. A sleep does not fully release Chrome memory; safe process restarts and
the short-lived upload-date pages controlled by `PHOTO_DATE_BATCH_SIZE` are the
primary memory controls. Disabling upload-date collection reduces per-photo work
but omits client-required evidence for judging whether a menu photo is current.
Disabling main photo collection produces the largest runtime and memory
reduction, but the analyzer will then have no photo input.

## Troubleshooting

### `Unknown process listing header: WorkingSetSiz`

PowerShell truncated the Windows `WorkingSetSize` header Crawlee expected. The
current `src/main.js` forces `COLUMNS=200`, and `.env` keeps that setting visible.
Use the current code and restart the command.

### Chrome crashes or memory usage keeps growing

Use `npm run start:safe`, keep `SAFE_BATCH_SIZE=4` or reduce it to 2, keep
`PHOTO_DATE_CONCURRENCY=1`, and reduce `PHOTO_DATE_BATCH_SIZE=10` to 5 if needed.
Leave `PHOTO_CAPTURE_UPLOAD_DATE=true` for complete client output. If the process stops
after making progress, use `npm run resume:safe` rather than starting a new
scrape. Set upload-date capture to `false` only for diagnosis or an explicitly
incomplete faster run.

### Chrome says the profile is already in use

Close every Chrome window created by this project and stop any running login,
main scraper, or review scraper. Wait for `SAFE_RESTART_DELAY_MS`. Only one
process can safely use `.chrome-profile` at a time.

### Maps asks for sign-in or hides Menu and Reviews

Run `npm run login`, confirm the complete Maps interface manually, and close that
Chrome window. If a headless run still receives reduced content, use
`npm run start:visible` for diagnosis.

### Fewer locations than `MAX_PLACES`

The value is an upper limit. Check per-search discovery logs. Increase
`MAX_CANDIDATES_PER_AREA`, use precise terms, split a broad area into smaller
districts, increase `SCROLL_WAIT_MS` for a slow connection, and account for
deduplication across searches.

### Safe mode appears capped at four

Four is the default Chrome batch size, not the final place limit. Let safe mode
restart Chrome. Check its handled and pending counts and the final JSON length.

### A menu is missing or incomplete

Verify that the signed-in visible browser displays a structured Menu tab.
Google lazily loads and virtualizes menu categories. Retry the affected place by
exact name or direct URL. Missing dishes and prices remain `null`; the scraper
does not infer them from photos.

### A place has fewer than the requested photos

Google may expose fewer unique images or several tabs may contain the same
photos. Inspect `photoScrape.tabs`. Increase `PHOTO_SCAN_LIMIT` and
`PHOTO_SCROLL_ROUNDS` only when the gallery visibly contains more images.

### Review output is partial or failed

Inspect `reviewScrape.error`, `attempts`, `stalledScrolls`,
`newestOrderViolations`, and `unexpandedReviewCount` in the place record.
Verify the Reviews interface and requested sort with the dedicated profile.

### Photo analysis was interrupted

Run `npm run analyze:photos:resume`. The first run can also appear slower while
the model and OCR language data are downloaded.

### OCR is empty or OCR accuracy shows `n/a`

OCR runs only on automatically predicted menus. `none` means OCR ran but found
no usable text. OCR accuracy requires manually corrected expected text. Copy and
correct OCR text in the labeller, save it, and rerun evaluation.

### A CSV is locked on Windows

Close it in Excel and disable File Explorer's preview pane if necessary. The
labeller retries atomic saves. Evaluation-only mode does not rewrite
`photo-labels-template.csv`, so a locked template no longer blocks metrics.

### Brand fields remain `null`

The current catalog is empty or no unique entry matched. Add evidence-backed
Malaysia counts to `config/malaysia-chain-counts.json`, then rerun the main
scraper.

## Additional limitations

- Google Maps selectors can change because of interface updates, localization,
  or experiments.
- Full-size Google-hosted photo URLs can expire later.
- Review dates remain relative text and are not invented as exact dates.
- Reviews deliberately exclude reviewer details and owner responses.
- Brand classification never guesses beyond the verified catalog.
- OCR does not convert photo text into the main structured dish schema.
- The current Excel quick view is a one-off export, not an automatic npm output.
- The scraper does not bypass CAPTCHAs or use aggressive anti-bot evasion.

## Project structure

```text
src/
  main.js               Main discovery, detail, menu, photo, and review scraper
  safe-run.js           Restartable low-memory runner
  login.js              Dedicated normal-Chrome login
  review-scraper.js     Shared privacy-limited review collection
  brand-classifier.js   Malaysia brand matching and size rules
  analyze-photos.js     CLIP classification, OCR, checkpoints, and evaluation
  label-photos.js       Local browser labelling interface
  paddleocr-menu.py     PaddleOCR worker and standalone menu-photo runner
  parse-menu-ocr.py     Structured menu-photo parser
  match-menus.py        Typed-menu and photo-menu matcher
  export-results.js     Shared Excel and flat photo-list export entry point
  common-utils.js       Shared values, CSV, file checks, and timing helpers
  google-ui-utils.js    Shared Google consent interaction
  excel-utils.js        Shared Excel sheet formatting
  local-tool-utils.js   Shared local labeller HTTP and file helpers
  output-paths.js       Shared dated/type-based JavaScript output layout
  output_paths.py       Shared photo-analysis Python output layout

config/
  malaysia-chain-counts.json
  photo-analysis-labels.csv

output/
  scraper/<date>/<time>/
    json/
    csv/
    xlsx/
    other/
  photo-classification/<date>/<time>/
    json/
    csv/
    xlsx/
    other/
  photo-analysis/<date>/<time>/
    paddleocr/{json,csv,xlsx,other}/
    menu-parsing/{json,csv,xlsx,other}/
    menu-matching/{json,csv,xlsx,other}/

storage/                Crawlee queue and dataset state
.chrome-profile/        Sensitive dedicated Google profile
.cache/transformers/    Image model cache
.cache/tesseract/       OCR language cache
```

`src/recon-photos.js` is no longer needed. Its validated photo collection was
integrated into `src/main.js`, and the separate file was removed.
