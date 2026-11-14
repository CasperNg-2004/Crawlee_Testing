# Documentation index

This folder contains the detailed operating and reference documentation for the
Google Maps café and drinks data pipeline. Start with setup, then follow the
guides in pipeline order.

| Guide | Use it for |
| --- | --- |
| [Setup and Google login](setup-and-login.md) | Requirements, installation, technologies, PaddleOCR setup, and the dedicated Google profile. |
| [Scraper guide](scraper-guide.md) | Inputs, `.env` configuration, safe runs, one-place runs, safety stops, menus, photos, and reviews. |
| [Photo classification](photo-classification.md) | CLIP classification, manual category labels, OCR-review website, evaluation, and annotated images. |
| [PaddleOCR and menu parsing](paddleocr-and-menu-parsing.md) | OCR records, standalone OCR, structured menu parsing, unpaired-line review, and ground truth. |
| [Menu matching](menu-matching.md) | Typed-versus-photo matching, status meanings, metrics, and creation of `menu-check.xlsx`. |
| [Output reference](output-reference.md) | Numbered output folders, schemas, field meanings, files, and workbook sheets. |
| [Troubleshooting](troubleshooting.md) | Memory, Chrome profiles, Google blocks, missing data, runtime, and known limitations. |

## Complete pipeline

```text
Google login
    ↓
Main scraper → restaurants.json / CSV / Excel / photo list
    ↓
CLIP photo classification + PaddleOCR
    ↓
Manual photo labels and optional OCR character evaluation
    ↓
Structured menu-photo parsing
    ↓
Optional unresolved-price review
    ↓
Typed-menu versus photo-menu matching
    ↓
menu-check.xlsx
```

## Normal command order

Replace `Running#N` with the folder created by your scrape.

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

[Return to the project overview](../README.md)
