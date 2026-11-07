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
npm run analyze:photos
```

It processes every place in the input unless `PHOTO_ANALYSIS_PLACE_LIMIT` is a
positive number. Results go to a timestamped folder under
`output/photo-analysis/`. If interrupted, use `npm run analyze:photos:resume`.
The first run downloads the quantized CLIP model and Tesseract language files.

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
