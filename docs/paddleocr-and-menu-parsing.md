# PaddleOCR and structured menu parsing

[Documentation index](README.md) · [Photo classification](photo-classification.md) · [Menu matching](menu-matching.md)

## Integrated OCR output

`npm run analyze:photos` starts one reusable PaddleOCR worker and stores OCR data
inside each automatically detected menu photo in `photo-analysis.json`.

An OCR record contains:

- `status`: `success`, `none`, or `failed`
- engine and model size
- extracted text and mean confidence
- ordered text lines with bounding boxes and polygons
- conservative price candidates and source line indexes
- elapsed seconds
- annotated-image status, relative path, dimensions, and line counts

`none` means OCR ran but found no usable text. `failed` means recognition did not
complete reliably. `ocr: null` means OCR was not attempted because CLIP did not
classify the image as a menu.

## Optional standalone PaddleOCR runner

Use this for an isolated image or folder benchmark:

```powershell
npm run recon:paddleocr -- "C:\path\to\menu-photos"
```

To save standalone marked-up images:

```powershell
npm run recon:paddleocr -- "C:\path\to\menu-photos" `
  --output-dir "output\Running#N\photo-analysis\paddleocr" `
  --save-visualizations
```

The standalone output includes `paddleocr-analysis.json`, a partial checkpoint,
text lines, confidence, coordinates, price candidates, and optional PaddleOCR
visualizations.

## Parse OCR into menu offers

For the normal integrated route:

```powershell
npm run parse:menu-ocr -- `
  "output\Running#N\photo-classification\json\photo-analysis.json"
```

Standalone OCR is also accepted:

```powershell
npm run parse:menu-ocr -- `
  "output\Running#N\photo-analysis\paddleocr\json\paddleocr-analysis.json"
```

The parser treats prices as layout anchors, detects price columns, and associates
nearby text using horizontal and vertical geometry. Fuzzy matching is optional
validation against a typed-menu catalog; it does not decide which price belongs
to an item and never replaces raw OCR names.

The parser never invents a price or currency. Multi-price items preserve
`prices[]`; single-price fields remain `null` when choosing one value would be
unsafe.

## Parser outputs

```text
output\Running#N\photo-analysis\menu-parsing\
├── json\structured-menu.json
├── json\ambiguous-items.json
├── json\unpaired-lines.json
├── json\evaluation.json
├── json\ground-truth-template.json
└── csv\structured-menu.csv
```

- `structured-menu.json`: full items, variants, confidence, boxes, and evidence.
- `ambiguous-items.json`: plausible pairs that could not be selected safely.
- `unpaired-lines.json`: price and text evidence left unresolved.
- `evaluation.json`: measured correct/wrong/missed results when ground truth exists.
- `ground-truth-template.json`: empty human-verification template.

## Review unresolved price lines

```powershell
npm run label:menu-ocr
```

The local reviewer opens at `http://127.0.0.1:3792`. It displays the source
photo and highlighted unresolved line. Available categories include item price,
variant, add-on, bundle, not a price, duplicate, unreadable, and unknown.

Any category that creates menu data requires a visually verified name, displayed
price text, and numeric price. Currency may remain empty and is never inferred.
Labels save atomically to `config/menu-ocr-unpaired-labels.json` by default.

Apply them by rerunning the parser:

```powershell
npm run parse:menu-ocr -- `
  "output\Running#N\photo-classification\json\photo-analysis.json" `
  --unpaired-labels "config\menu-ocr-unpaired-labels.json" `
  --output-dir "output\Running#N\photo-analysis\menu-parsing"
```

Human-verified data is retained with `humanVerified: true`. `not_a_price` and
`duplicate` resolve evidence without creating an item; `unreadable` and
`unknown` remain unresolved.

## Measure name-price accuracy

Fill the generated ground-truth template by checking source images, then run:

```powershell
npm run parse:menu-ocr -- "<photo-analysis-or-paddleocr.json>" `
  --ground-truth "config\menu-ocr-ground-truth.json"
```

Measured evaluation reports correct, wrong, and missed prices plus correct,
wrong, and missed name-price pairs. Candidate counts and matching coverage are
not substitutes for this ground truth.

## Current parser baseline

The newest 130-image menu set produced 1,141 candidate items, including 127
ambiguous items and 743 unpaired price lines. No parser ground truth or reviewed
unpaired lines had been applied at the time of that output. These figures show
coverage and unresolved workload, not accuracy.

Continue with [typed-menu versus photo-menu matching](menu-matching.md).
