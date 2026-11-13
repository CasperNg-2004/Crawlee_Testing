# Photo tools handover

## Scraper photo output

Run the normal safe scraper with photo collection enabled in `.env`:

```powershell
npm run start:safe
```

Each completed output directory contains:

- `restaurants.json`: full place records with nested photo metadata.
- `photo-list.json`: flat reader input with one object per photo and source tab.
- `photo-list.csv`: the same flat reader input for spreadsheets and imports.

The flat files contain `placeId`, `shopName`, `photoId`, `tab`, `uploadDate`, and
`fullSizeImageUrl`. A photo found in two Google tabs appears in two rows. A
missing Google value remains `null` in JSON and blank in CSV.

To rebuild the flat files from an existing main output without scraping again:

```powershell
npm run export:photos -- output\restaurants.json
```

An optional second path writes the files to another directory:

```powershell
npm run export:photos -- output\restaurants.json output\reader-export
```

Keep these client-quality settings:

```dotenv
SCRAPE_PHOTOS=true
PHOTO_CAPTURE_UPLOAD_DATE=true
PHOTO_DATE_BATCH_SIZE=10
PHOTO_DATE_CONCURRENCY=1
PHOTO_PROBE_CONCURRENCY=2
```

## Independent photo analyzer

`src/analyze-photos.js` reads existing photo URLs; it does not launch Maps or
change scraper output. Its default input is `output/restaurants.json`.

```powershell
npm install
npm run setup:paddleocr
npm run analyze:photos
```

It processes every place in the input unless `PHOTO_ANALYSIS_PLACE_LIMIT` is a
positive number. Results go to a timestamped folder under
`output/photo-analysis/`. If interrupted, use `npm run analyze:photos:resume`.
The first run downloads the quantized CLIP model and official PaddleOCR models.
PaddleOCR runs in an isolated `.venv-paddleocr` environment and uses one
persistent worker for every automatically predicted menu photo. The default
PP-OCRv6 small models preserve text coordinates, confidence, raw text, and
conservative price candidates.

Keep these settings for the current laptop:

```dotenv
PHOTO_ANALYSIS_OCR_ENGINE=paddleocr
PHOTO_ANALYSIS_OCR_IMAGE_SIZE=1800
PHOTO_ANALYSIS_PADDLE_PYTHON=.venv-paddleocr/Scripts/python.exe
PHOTO_ANALYSIS_PADDLE_MODEL_SIZE=small
PHOTO_ANALYSIS_PADDLE_CPU_THREADS=4
```

Each PaddleOCR image result adds `engine`, `modelSize`, `lines`,
`priceCandidates`, and `elapsedSeconds` under `ocr`. Numeric-only price
candidates retain `currency: null`; the tool never guesses currency. Candidate
counts do not measure accuracy until correct, wrong, and missed prices are
checked against human ground truth.

Existing Tesseract folders and labels are preserved. To reproduce or resume an
older Tesseract checkpoint in the current PowerShell session:

```powershell
$env:PHOTO_ANALYSIS_OCR_ENGINE='tesseract'
npm run analyze:photos:resume
```

Do not resume one checkpoint with a different OCR engine. The analyzer detects
and stops this instead of producing a mixed report.

## Manual photo labeller

After an analysis completes, run:

```powershell
npm run label:photos
```

`src/label-photos.js` opens `http://127.0.0.1:3789`, loads the newest completed
analysis, and shows one photo at a time. Select `menu`, `food`, `interior`, or
`unknown` with the buttons or keys `1`–`4`. Every selection is autosaved to
`config/photo-analysis-labels.csv`; `Ctrl+C` stops the server without discarding
saved choices. Keep the CSV closed in Excel while labelling.

The current 1,496 labels were made through that browser interface by manually
viewing and categorizing each image. The saved set contains 86 `menu`, 854
`food`, 393 `interior`, and 163 `unknown` labels, all with unique photo IDs and
image URLs. The optional `expectedOcrText` field was not filled, so these labels
measure category accuracy but not OCR transcription accuracy.

The labeller displays the OCR engine, OCR confidence, PaddleOCR price-candidate
count, and OCR processing time when those values are available.

## Photo classification evaluation

Two manually labelled datasets have been evaluated:

| Dataset | Labels | Accuracy | Macro precision | Macro recall | Macro F1 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Original evaluation (18 October 2026) | 1,496 | 76.14% | 64.07% | 75.98% | 66.09% |
| Latest evaluation (7 November 2026) | 596 | 81.21% | 70.13% | 77.12% | 70.92% |

These metrics measure classification into `menu`, `food`, `interior`, and
`unknown`. They do not measure OCR transcription accuracy because the
`expectedOcrText` labels were not completed. The latest dataset scored higher,
but the two results should not be treated as a strict model-to-model comparison
because their photo and category distributions may differ.

Recalculate classification metrics without downloading the photos again:

```powershell
npm run analyze:photos:evaluate
```

Photo reading and interpretation are now handed over to the intern; these tools
are retained only so the team can reproduce the existing analysis and labels.

## PaddleOCR verification completed

The independent 20-photo run completed 20/20 menu photos without failure. It
recognized 1,546 text lines and produced 480 price candidates. OCR inference
averaged 14.016 seconds per photo with a 12.779-second median; the complete run,
including model startup, result writing, and visualizations, took 361.845
seconds. These are runtime and extraction counts, not price-accuracy metrics.

The integrated classifier-to-PaddleOCR smoke test analyzed 5/5 photos without
failure. Two predicted menu photos produced OCR successfully; the detailed menu
returned 121 positioned lines and 49 price candidates in 33.854 seconds.

## Structured menu-photo parser

The parser remains independent until its accuracy is measured. Run it after a
standalone PaddleOCR folder test:

```powershell
npm run parse:menu-ocr -- `
  "output\paddleocr\menu-20-2026-11-10\paddleocr-analysis.json" `
  --output-dir "output\menu-ocr-parsing\my-run"
```

It uses price anchors and column geometry for pairing. Fuzzy matching is only an
optional typed-menu validation layer and never selects or invents a price.
Outputs include structured JSON and CSV, ambiguous items, unpaired evidence, an
evaluation report, and an empty ground-truth template.

To measure correct, wrong, and missed prices, manually fill the generated
`ground-truth-template.json` while viewing each source image, then rerun with:

```powershell
npm run parse:menu-ocr -- "<paddleocr-analysis.json>" `
  --ground-truth "config\menu-ocr-ground-truth.json"
```

The current unverified 20-photo baseline produced 345 item candidates, 20
ambiguous items, and 45 unpaired price lines. Do not present these coverage
counts as accuracy. The example schemas are
`config/menu-ocr-ground-truth.example.json` and
`config/menu-ocr-typed-menu.example.json`.

## Reviewing unpaired OCR prices

Open the local browser reviewer after a parser run:

```powershell
npm run label:menu-ocr
```

The tool uses the newest parser output by default, highlights each unresolved
OCR line on its source photo, and saves manual categories and corrections to
`config/menu-ocr-unpaired-labels.json`. It never guesses a name, price, or
currency. Apply the reviewed evidence by rerunning:

```powershell
npm run parse:menu-ocr -- "<paddleocr-analysis.json>" `
  --unpaired-labels "config\menu-ocr-unpaired-labels.json" `
  --output-dir "output\menu-ocr-parsing\reviewed-run"
```

Only the human-verified item, variant, add-on, and bundle categories create or
update structured menu data. `not_a_price` and `duplicate` resolve evidence
without creating an item, while `unreadable` and `unknown` remain unresolved.
