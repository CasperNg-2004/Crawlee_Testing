# Menu matching and `menu-check.xlsx`

[Documentation index](README.md) · [Menu parsing](paddleocr-and-menu-parsing.md) · [Output reference](output-reference.md)

## Match typed and photographed menus

The integrated parser preserves exact place IDs and photo IDs, so no separate
photo map is required:

```powershell
npm run match:menus -- `
  --restaurants "output\Running#N\scraper\json\restaurants.json" `
  --structured "output\Running#N\photo-analysis\menu-parsing\json\structured-menu.json"
```

The matcher is deterministic and one-to-one. It compares normalized names,
variant tokens, prices, currencies, photo dates, OCR confidence, and ambiguity
evidence. It never fills missing prices or currencies.

The default thresholds in `config/menu-matching.json` are 0.90 for an accepted
name match and 0.75 for the manual-review band. Only verified synonyms should
be added. `ais → iced` is the initial verified synonym.

## Standalone image mapping

Use a photo map only when an external image set lacks exact place and photo IDs:

```powershell
npm run build:photo-map -- `
  --selection "<selection.json>" `
  --photo-list "output\Running#N\scraper\json\photo-list.json" `
  --output "output\Running#N\photo-analysis\menu-parsing\csv\photo-map.csv"
```

The mapper joins exact IDs and never assigns photos by restaurant-name
similarity. Unresolved images remain unlinked and are reported.

## Item statuses

| Status | Meaning |
| --- | --- |
| `MATCH` | Name and comparable price agree. |
| `PRICE_DIFF` | The offer matches, but comparable prices differ. |
| `PRICE_NOT_COMPARABLE` | The offer matches, but price evidence cannot be compared safely. |
| `REVIEW` | The candidate is plausible but requires a person. |
| `ONLY_GOOGLE` | Present only in the typed Google menu. |
| `ONLY_PHOTO` | Present only in parsed photo evidence. |

Place-level results keep `NO_GOOGLE_MENU`, `GOOGLE_MENU_FAILED`, and
`NO_MENU_PHOTOS` separate.

When one offer appears in several photos, the newest determinable upload date is
used. Other copies remain under `otherPhotoPrices`. Missing or tied dates force
review instead of being guessed.

## Matching outputs

```text
output\Running#N\photo-analysis\menu-matching\
├── json\menu-matches.json
├── json\unlinked-images.json
├── csv\menu-matches.csv
└── xlsx\menu-check.xlsx
```

`menu-matches.json` contains settings, place and item results, evidence,
estimated metrics, and optional measured evaluation.

## Generate the reader workbook

```powershell
npm run export:report -- `
  "output\Running#N\photo-analysis\menu-matching\json\menu-matches.json"
```

The workbook contains:

- **Summary**: one row per place with offer counts, coverage, dates, and Maps link.
- **Items**: complete comparison ledger with names, prices, scores, and evidence.
- **Review**: only `REVIEW` and `PRICE_DIFF`, with Accept/Reject/Correct fields.
- **Photos**: source-image audit, parsing status, and upload dates.
- **Metrics**: estimated coverage and any measured ground-truth metrics.
- **Info**: input files, thresholds, settings, and audit information.

Workbook decisions are notes only. They do not write back to JSON.

## Estimated versus measured metrics

Without human ground truth, coverage, agreement, mean name score, and OCR
confidence are labelled **estimated**. They describe pipeline behavior and must
not be presented as precision or accuracy.

Provide data matching `config/menu-match-ground-truth.example.json` with
`--ground-truth` to measure precision, recall, F1, price-verdict accuracy, and
threshold behavior.

## Current matching baseline

| Result | Count |
| --- | ---: |
| Google typed offers | 1,079 |
| Photo offers | 926 |
| Paired offers | 333 |
| `MATCH` | 94 |
| `PRICE_DIFF` | 49 |
| `PRICE_NOT_COMPARABLE` | 20 |
| `REVIEW` | 170 |
| `ONLY_GOOGLE` | 746 |
| `ONLY_PHOTO` | 593 |

Google coverage is 30.86%, photo coverage is 35.96%, and comparable price
agreement is 53.70%. These are estimated because the matching ground-truth
sample is still empty.
