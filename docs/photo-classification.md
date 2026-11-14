# Photo classification and validation

[Documentation index](README.md) · [Scraper guide](scraper-guide.md) · [PaddleOCR and parsing](paddleocr-and-menu-parsing.md)

## Run classification and OCR

```powershell
npm run analyze:photos
```

The command selects the newest numbered scraper run unless
`PHOTO_ANALYSIS_INPUT` is set. It analyzes every place in the input when
`PHOTO_ANALYSIS_PLACE_LIMIT` is empty.

For each saved photo, the pipeline:

1. Downloads a resized analysis copy while preserving the full-size URL.
2. Uses CLIP zero-shot prompts to rank `menu`, `food`, `interior`, and `unknown`.
3. Converts weak or narrowly separated predictions to `unknown`.
4. Runs PaddleOCR only when the automatic category is `menu`.
5. Saves positioned OCR lines, prices, timing, and an annotated JPEG.
6. Writes a checkpoint after every restaurant.

Resume an interrupted checkpoint with:

```powershell
npm run analyze:photos:resume
```

A checkpoint must use the same OCR engine with which it started.

## Validated low-memory configuration

```dotenv
PHOTO_ANALYSIS_PLACE_LIMIT=
PHOTO_ANALYSIS_MAX_PHOTOS_PER_PLACE=30
PHOTO_ANALYSIS_MODEL=Xenova/clip-vit-base-patch32
PHOTO_ANALYSIS_DTYPE=q8
PHOTO_ANALYSIS_DEVICE=cpu
PHOTO_ANALYSIS_IMAGE_SIZE=1280
PHOTO_ANALYSIS_DELAY_MS=250
PHOTO_ANALYSIS_MIN_SCORE=0.42
PHOTO_ANALYSIS_MIN_MARGIN=0.08
PHOTO_ANALYSIS_OCR_ENGINE=paddleocr
PHOTO_ANALYSIS_OCR_IMAGE_SIZE=1800
PHOTO_ANALYSIS_PADDLE_MODEL_SIZE=small
PHOTO_ANALYSIS_PADDLE_CPU_THREADS=4
```

CLIP scores rank the configured prompts. They are not calibrated probabilities.

## Manual category labelling

```powershell
npm run label:photos
```

The local browser opens at `http://127.0.0.1:3789` and loads the newest completed
classification run. Use `PHOTO_LABEL_INPUT` to pin an older `Running#N`.

Choose the real category for every image. Labels autosave to:

```text
output\Running#N\photo-classification\csv\photo-analysis-labels.csv
```

Human labels are run-specific ground truth and are never replaced automatically
by model predictions.

## OCR character review

```powershell
npm run label:ocr
```

This uses the same website in OCR mode. Correct `expectedOcrText` exactly as it
appears in the source photo. Character accuracy is normalized Levenshtein
similarity between corrected text and extracted OCR text. Category labels alone
are not OCR ground truth.

The viewer provides:

- **Original**: the source analysis photo.
- **OCR boxes**: the same image with PaddleOCR polygons.
- Cyan polygons: recognized text lines.
- Amber polygons: lines detected as possible prices.
- Numbered OCR text beside the image for comparison.

New analysis runs save all successful visualizations under:

```text
output\Running#N\photo-classification\other\ocr-visualizations\*-ocr.jpg
```

For an older run, opening **OCR boxes** generates that image on demand. The
original full-size photo is never overwritten.

## Calculate evaluation metrics

```powershell
npm run analyze:photos:evaluate
```

The result includes labelled sample size, accuracy, per-category precision,
recall, F1, confusion matrix, and optional mean OCR character accuracy. Metrics
apply only to the manually labelled sample.

Definitions:

- Accuracy: all correctly classified labelled images divided by all labels.
- Precision: correct predictions for a category divided by all predictions of it.
- Recall: correct predictions for a category divided by all actual examples.
- F1: harmonic mean of precision and recall.
- Macro metrics: unweighted mean across the four categories.

## Current verified classification baseline

The current 600-image labelled set reports:

- Overall accuracy: 83.83%
- Macro precision: 73.38%
- Macro recall: 82.54%
- Macro F1: 75.17%
- Actual menu photos: 130
- Correct menu predictions: 125
- Menu recall: 96.15%
- Menu precision: 66.84%
- Missed menus: 5

This remains below the client's 98% menu-recall target. The five missed menu
photos and 62 non-menu false positives are the next classifier cases to improve.

## Important limitation

Manual category corrections do not retroactively run OCR. If CLIP missed an
actual menu photo, that image has no OCR result until analysis is rerun with
improved prompts, thresholds, or selection logic.

Continue with [PaddleOCR and structured menu parsing](paddleocr-and-menu-parsing.md).
