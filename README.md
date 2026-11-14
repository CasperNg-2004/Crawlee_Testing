# Google Maps café and drinks data pipeline

A Windows/Node.js Crawlee and Playwright pipeline for collecting public Google
Maps café and drinks data in Malaysia, classifying photos with CLIP, reading menu
photos with PaddleOCR, structuring OCR menu evidence, and comparing photographed
menus with Google's typed menus.

The main output is organized into numbered runs so every scraper, classification,
OCR, parsing, and matching result stays together:

```text
output\Running#N\
├── scraper\
├── photo-classification\
└── photo-analysis\
```

## Documentation

Detailed instructions now live in the [`docs/`](docs/README.md) folder:

| Guide | Contents |
| --- | --- |
| [Documentation index](docs/README.md) | Pipeline diagram and command order. |
| [Setup and Google login](docs/setup-and-login.md) | Requirements, installation, technologies, and dedicated profile. |
| [Scraper guide](docs/scraper-guide.md) | Inputs, `.env`, safe runs, menus, photos, reviews, and safety stops. |
| [Photo classification](docs/photo-classification.md) | CLIP, manual labels, evaluation, and OCR-box images. |
| [PaddleOCR and menu parsing](docs/paddleocr-and-menu-parsing.md) | OCR output, structured parsing, unpaired prices, and ground truth. |
| [Menu matching](docs/menu-matching.md) | Matching rules, statuses, metrics, and `menu-check.xlsx`. |
| [Output reference](docs/output-reference.md) | Folder layout, record schema, and workbook sheets. |
| [Troubleshooting](docs/troubleshooting.md) | Memory, profiles, blocks, runtime, and known gaps. |

## Quick start

### 1. Install once

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
npm run setup:paddleocr
```

### 2. Sign in to the dedicated Maps profile

```powershell
npm run login
```

Sign in manually, confirm that a Maps place shows Menu, Photos, and Reviews, and
close every Chrome window opened by the login command.

### 3. Configure `.env`

Use direct client inputs:

```dotenv
PLACE_IDS=ChIJ...|ChIJ...
PLACE_URLS=
MAX_PLACES=20
```

Or clear the direct inputs and use discovery:

```dotenv
QUERIES=cafes|drink
AREAS=Kuala Lumpur City Centre|Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur
MAX_PLACES=20
```

`MAX_PLACES` is one shared final cap, not a per-area limit.

### 4. Run the complete pipeline

Replace `Running#N` with the folder created by the scraper:

```powershell
npm run start:safe
npm run analyze:photos
npm run label:photos
npm run analyze:photos:evaluate
npm run parse:menu-ocr -- "output\Running#N\photo-classification\json\photo-analysis.json"
npm run label:menu-ocr
npm run parse:menu-ocr -- "output\Running#N\photo-classification\json\photo-analysis.json" --unpaired-labels "config\menu-ocr-unpaired-labels.json" --output-dir "output\Running#N\photo-analysis\menu-parsing"
npm run match:menus -- --restaurants "output\Running#N\scraper\json\restaurants.json" --structured "output\Running#N\photo-analysis\menu-parsing\json\structured-menu.json"
npm run export:report -- "output\Running#N\photo-analysis\menu-matching\json\menu-matches.json"
```

The final reader-facing workbook is:

```text
output\Running#N\photo-analysis\menu-matching\xlsx\menu-check.xlsx
```

See the [complete command-by-command workflow](docs/README.md) before running a
production batch.

## Core capabilities

- Area discovery or direct Google place IDs and supported URLs
- Headless and visible browser modes
- Restartable low-memory safe batches
- Typed menus with section, name, description, displayed price, numeric price,
  and currency
- Business details, weekly hours, Popular Times, peaks, and About attributes
- Five photo tabs with photo IDs, full-size URLs, dates, dimensions, and statuses
- Up to 50 newest privacy-limited reviews
- Malaysia brand-size lookup from a verified catalog
- CLIP photo classification and manual ground-truth labelling
- PaddleOCR text, polygons, prices, timing, and annotated OCR images
- Layout-aware photo-menu parsing and unresolved-price review
- Deterministic typed-versus-photo menu matching
- JSON, CSV, and Excel exports

## Data guarantees

- A place is never excluded because it has no typed Google menu.
- Missing menu dishes, prices, currencies, descriptions, dates, and outlet
  counts are never guessed.
- `menuScrape.tabExists` remains separate from menu status.
- `none` means the UI loaded and absence was confirmed; `failed` means it did
  not load reliably.
- Google blocks, CAPTCHA, and signed-out states stop the run instead of producing
  false `none` results.
- Place ID, feature ID, latitude, longitude, and closure status are preserved.
- Photos keep IDs, full-size URLs, matching tabs, upload dates, width, and height;
  videos are skipped.
- Phone and website remain under `contact`; address stays top-level.
- Reviewer identity and owner responses are excluded.
- Failed runs exit non-zero and print `RUN_SUMMARY`.

## Common commands

| Command | Purpose |
| --- | --- |
| `npm run login` | Open the dedicated profile for manual Google sign-in. |
| `npm run start:safe` | Start a fresh restartable batch. |
| `npm run resume:safe` | Resume the same preserved queue. |
| `npm run scrape:one -- "ChIJ..."` | Scrape one direct place. |
| `npm run start:visible` | Run a visible-browser diagnostic. |
| `npm run analyze:photos` | Classify photos and run PaddleOCR. |
| `npm run analyze:photos:resume` | Resume photo-analysis checkpoints. |
| `npm run label:photos` | Label photo categories in a local browser. |
| `npm run label:ocr` | Correct OCR text and measure character accuracy. |
| `npm run analyze:photos:evaluate` | Recalculate classification and OCR metrics. |
| `npm run parse:menu-ocr -- "<input.json>"` | Parse positioned OCR into menu offers. |
| `npm run label:menu-ocr` | Categorize unresolved OCR price lines. |
| `npm run match:menus -- ...` | Match typed and photographed menu offers. |
| `npm run export:report -- "<menu-matches.json>"` | Build `menu-check.xlsx`. |
| `npm run export:excel` | Rebuild scraper Excel output. |
| `npm run export:photos` | Rebuild the client photo list. |
| `npm test` | Run the Node.js test suite. |

## Current verified state

- Main scraper: 20/20 places completed, 0 failed
- Typed Google menu offers: 1,079
- Photos classified: 600/600
- Classification accuracy: 83.83%
- Menu-photo recall: 96.15% (125/130)
- PaddleOCR automatic successes: 161
- Structured photo-menu candidates: 1,141
- Exact photo links for matching: 130/130
- Matched menu offers: 333
- Matching ground-truth evaluation: not yet completed

See [Troubleshooting and known gaps](docs/troubleshooting.md) before presenting
estimated matching coverage as accuracy.

## Project structure

```text
src/
  main.js                     Main Maps scraper
  safe-run.js                 Restartable batch runner
  analyze-photos.js           CLIP and integrated OCR pipeline
  label-photos.js             Category and OCR browser reviewer
  ocr-visualization.js        Annotated PaddleOCR images
  paddleocr-menu.py           PaddleOCR worker and standalone runner
  parse-menu-ocr.py           Structured photo-menu parser
  label-menu-ocr-unpaired.js  Unresolved-price reviewer
  match-menus.py              Typed-versus-photo matcher
  menu-match-report.js        Reader-facing workbook exporter
config/
  malaysia-chain-counts.json
  menu-matching.json
docs/
  README.md
  setup-and-login.md
  scraper-guide.md
  photo-classification.md
  paddleocr-and-menu-parsing.md
  menu-matching.md
  output-reference.md
  troubleshooting.md
```
