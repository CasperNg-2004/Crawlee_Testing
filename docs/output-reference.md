# Output and schema reference

[Documentation index](README.md) · [Scraper guide](scraper-guide.md) · [Menu matching](menu-matching.md)

## Numbered pipeline layout

Every fresh scrape creates `output/Running#N`. All later stages for that scrape
must remain under the same number.

```text
output\Running#N\
├── scraper\
│   ├── json\restaurants.json
│   ├── json\failed-restaurants.json
│   ├── json\photo-list.json
│   ├── csv\restaurants.csv
│   ├── csv\photo-list.csv
│   ├── xlsx\restaurants.xlsx
│   └── other\run-summary.json
├── photo-classification\
│   ├── json\photo-analysis.json
│   ├── json\evaluation.json
│   ├── csv\photo-analysis-labels.csv
│   └── other\ocr-visualizations\*-ocr.jpg
└── photo-analysis\
    ├── paddleocr\{json,csv,xlsx,other}\
    ├── menu-parsing\{json,csv,xlsx,other}\
    └── menu-matching\{json,csv,xlsx,other}\
```

JSON is the authoritative structured output. CSV is intended for flat review,
and Excel is the easiest client-facing format.

## Main place record

Top-level field order:

```text
name
placeId
featureId
latitude
longitude
rating
area
category
businessStatus
brandSize
numberOfOutlets
address
contact
reviewCount
priceLevel
openingHours
menu
menuScrape
popularTimes
peakHours
query
about
photos
photoScrape
reviews
reviewScrape
googleMapsUrl
scrapedAt
```

`contact` contains only `phone` and `website`. Address remains top-level.
Missing Google data is `null`; values are never guessed.

## Typed menu

```json
{
  "menu": {
    "source": "google_maps",
    "sections": [
      {
        "name": "Coffee",
        "items": [
          {
            "name": "Latte",
            "description": "Description displayed by Google",
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
    "itemCount": 1
  }
}
```

When no typed dishes are available, `menu` is `null`. `tabExists` and status
remain separate so absence is not confused with a failed load.

## Photos

Each deduplicated photo retains `photoId`, `fullSizeImageUrl`, all matching
`tabs`, `uploadDate`, `width`, and `height`. Videos are skipped.

Tab limits are Menu 8, By owner 4, All 30, Food & drink 8, and Vibe 3. Selection
is newest-first using Google's displayed upload date.

`photo-list.json`, CSV, and Excel use one row per photo and tab with place ID,
shop name, photo ID, tab, upload date, and full-size link.

## Popular Times and peaks

`popularTimes` preserves the hourly Google values for every available day.
`peakHours` summarizes each day's peak, quiet periods, and the overall peak. The
numeric values are Google's relative popularity scale, not literal people counts.

## About attributes

`about` groups the attributes exposed by Google, such as service options,
accessibility, offerings, dining options, amenities, atmosphere, planning, and
payments. Missing groups are not inferred.

## Reviews

Main reviews default to 50 newest entries. Reviewer names, profile information,
and owner responses are excluded. `reviewScrape` records status, attempts,
target count, sort result, validation flags, and errors.

## Malaysia brand size

Verified counts come only from `config/malaysia-chain-counts.json`:

- independent: one Malaysia outlet
- small chain: 2–5
- mid chain: 6–15
- large chain: 16–40
- huge chain: 41+

Without a verified entry, `brandSize` and `numberOfOutlets` remain `null`.

## Photo-analysis records

Each analyzed image includes source IDs and URLs, dimensions, model scores,
selected category, confidence label, margin, OCR data, and errors. PaddleOCR
adds positioned lines, price candidates, timing, and visualization metadata.
Manual ground truth stays in the run-specific label CSV.

## `menu-check.xlsx`

| Sheet | Purpose |
| --- | --- |
| Summary | Place-level comparison and coverage. |
| Items | Every match, difference, review, and source-only offer. |
| Review | Manual decisions for uncertain matches and price differences. |
| Photos | Source-image audit and upload dates. |
| Metrics | Estimated and measured definitions. |
| Info | Input files and reproducibility settings. |

The current workbook has 20 Summary rows, 1,672 Items rows, 219 Review rows,
130 Photos rows, 6 Metrics rows, and 12 Info rows.
