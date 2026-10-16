# Google Maps food and drink scraper with Crawlee

A Crawlee and Playwright scraper for collecting public restaurant, café, and drink-place information from Google Maps. It can run multiple search terms across multiple Kuala Lumpur areas, distribute the final place limit fairly, visit each selected place, and export JSON and CSV files.

## Current capabilities

The scraper collects:

- restaurant name and category
- rating from 1 to 5 and review count
- displayed per-person price range, such as `RM 20–40 per person`, when Google provides one
- address, phone number, website, and plus code
- latitude and longitude
- weekly opening hours
- Google Maps menu categories and dishes
- hourly Google Maps Popular times for all available days, with daily and overall peak and quietest periods
- structured information from the About tab, including service options, accessibility, offerings, dining options, amenities, atmosphere, planning, and payments
- up to a configurable number of Google Maps photos, including photo ID, full-size image URL, source tab, width, height, and optional upload date
- photo-scrape status so unavailable photo tabs can be distinguished from failed page loads
- a grouped `contact` object containing phone, website, and address
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

If Google Maps does not provide a structured Menu tab for a restaurant, `menu` is `null`. Restaurants without menu dishes are still included in the output.

## Requirements

- Node.js 20 or newer
- Google Chrome
- Windows PowerShell for the command examples below

## Installation

```powershell
npm install
npx playwright install chromium
```

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
MAX_PLACES=1000
MAX_CANDIDATES_PER_AREA=150
AREAS=Kuala Lumpur City Centre|Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur
MAX_STALLED_SCROLLS=12
SCROLL_WAIT_MS=2000
HEADLESS=false
CHROME_PROFILE_DIR=.chrome-profile
SCRAPE_PHOTOS=true
PHOTO_TABS=All|Menu|By owner
PHOTO_MAX_PER_PLACE=30
PHOTO_SCAN_LIMIT=30
PHOTO_SCROLL_ROUNDS=120
PHOTO_CAPTURE_UPLOAD_DATE=false
```

### Configuration reference

| Setting | Meaning |
| --- | --- |
| `QUERY` | Google Maps search phrase, such as `restaurants` or `halal restaurants`. An exact restaurant name is also supported. |
| `QUERIES` | Optional `\|`-separated search phrases, such as `cafes\|drinks`. Takes precedence over `QUERY`; all query/area combinations are searched and deduplicated. |
| `AREA` | Single fallback search area. Used only when `AREAS` is empty or unset. |
| `AREAS` | Multiple search areas separated by `\|`. This takes precedence over `AREA`. |
| `MAX_PLACES` | Shared maximum number of restaurants in the final output, not a per-area limit. |
| `MAX_CANDIDATES_PER_AREA` | Maximum discovery candidates collected from each configured area before final selection. |
| `MAX_STALLED_SCROLLS` | Number of result-list scrolls with no new places before discovery stops. |
| `SCROLL_WAIT_MS` | Delay between result-list scrolls, in milliseconds. Increase it for slow connections. |
| `HEADLESS` | Keep this `false` for the most complete Google Maps and Menu interface. |
| `CHROME_PROFILE_DIR` | Dedicated signed-in Chrome profile used by login and scraping. |
| `CHROME_PATH` | Optional path to Chrome when it is installed in a non-standard location. |
| `SCRAPE_PHOTOS` | Enables Google Maps photo collection when set to `true`. |
| `PHOTO_TABS` | Photo tabs to inspect, separated by `\|`, such as `All\|Menu\|By owner`. |
| `PHOTO_MAX_PER_PLACE` | Maximum unique photos saved for each place. |
| `PHOTO_SCAN_LIMIT` | Maximum gallery candidates inspected while looking for the requested number of unique photos. |
| `PHOTO_SCROLL_ROUNDS` | Maximum photo-gallery scroll rounds before collection stops. |
| `PHOTO_CAPTURE_UPLOAD_DATE` | Enables the slower upload-date lookup. When `false`, `uploadDate` is `null`. |
| `SAFE_BATCH_SIZE` | Number of detail pages handled before safe mode restarts Chrome. |
| `SAFE_RESTART_DELAY_MS` | Delay between safe-mode Chrome batches. |
| `SAFE_MAX_CONSECUTIVE_FAILURES` | Number of consecutive failed batches allowed before safe mode stops. |

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

Safe mode defaults to four restaurant-detail requests per Chrome process. The
batch size, restart delay, and consecutive-failure limit can be configured with
`SAFE_BATCH_SIZE`, `SAFE_RESTART_DELAY_MS`, and
`SAFE_MAX_CONSECUTIVE_FAILURES` in `.env`.

Plain `npm start` runs the scraper in one process. Use it for short tests or a
single restaurant; it is not recommended for large photo-enabled runs:

```powershell
npm start
```

The provided `.env.example` already uses `HEADLESS=false`. The visible-browser shortcut is also available:

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

## Output

Each normal run writes:

- `output/restaurants.json`
- `output/restaurants.csv`
- `output/failed-restaurants.json`

Crawlee also keeps its local dataset under `storage/datasets/default/`. Nested fields such as `menu`, `openingHours`, `popularTimes`, `peakHours`, `about`, and `contact` are stored as JSON strings inside the CSV.

When Google Maps displays Popular times, `popularTimes` contains each displayed
hour for all seven days as a relative `busynessPercent`, plus daily and overall
peak and quietest periods. These percentages are Google's relative busyness
measure, not a count of people. Zero-percent readings remain in the hourly data,
but are excluded from quietest-period conclusions because Google may render zero
outside business hours. `peakHours` remains as a compact compatibility summary.

Photo records use `photoId`, `fullSizeImageUrl`, `tabs`, `uploadDate`, `width`,
and `height`. A successful photo scrape can contain fewer than the configured
limit when Google exposes fewer unique photos. When upload-date collection is
disabled, `uploadDate` is intentionally `null`.

### Expected JSON record

The following shortened example shows the complete top-level output structure.
Real records can contain seven Popular-times days, many menu sections, and up
to `PHOTO_MAX_PER_PLACE` photos.

```json
{
  "name": "Example Cafe",
  "category": "Cafe",
  "address": "1 Example Road, Kuala Lumpur",
  "phone": "03-1234 5678",
  "website": "https://example.com",
  "plusCode": "3C4X+2M Kuala Lumpur",
  "openingHours": [
    { "day": "Friday", "hours": "10 am–10 pm" }
  ],
  "rating": 4.5,
  "reviewCount": 320,
  "priceLevel": "RM 20–40 per person",
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
  "photos": [
    {
      "photoId": "google-photo-id",
      "sourceImageUrl": "https://lh3.googleusercontent.com/example=w203-h152-k-no",
      "photoIndex": 0,
      "discoverySource": "dom",
      "looksLikeVideo": false,
      "tabs": ["All", "Menu"],
      "uploadDate": null,
      "fullSizeImageUrl": "https://lh3.googleusercontent.com/example=s0",
      "width": 4000,
      "height": 3000
    }
  ],
  "photoScrape": {
    "status": "success",
    "tabs": {
      "All": { "status": "success", "attempts": 1, "photoCount": 30, "error": null },
      "Menu": { "status": "success", "attempts": 1, "photoCount": 8, "error": null },
      "By owner": { "status": "none", "attempts": 2, "photoCount": 0, "error": null }
    },
    "requestAttempts": 1
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
  "about": {
    "Service options": [
      { "name": "Delivery", "available": true },
      { "name": "Takeaway", "available": true },
      { "name": "Dine-in", "available": true }
    ]
  },
  "contact": {
    "phone": "03-1234 5678",
    "website": "https://example.com",
    "address": "1 Example Road, Kuala Lumpur"
  },
  "latitude": 3.139,
  "longitude": 101.6869,
  "googleMapsUrl": "https://www.google.com/maps/place/Example",
  "query": "cafes",
  "area": "Kuala Lumpur City Centre",
  "scrapedAt": "2026-10-17T02:05:36.979Z"
}
```

When Google does not provide a structured menu or Popular-times chart, the
corresponding field is `null`. When photo scraping is disabled, `photos` and
`photoScrape` are `null`; when it is enabled but no photos are found, `photos`
is an empty array. A failed photo page uses `photoScrape.status: "failed"`; a
confirmed tab with no photos uses `"none"`.

Progress logs include:

- discovered candidate totals for each area
- selected totals for each area
- per-restaurant scrape duration
- rating, review count, contact details, and menu item count
- failures and retries
- total elapsed time and exported record count

Crawlee purges its default local storage at the beginning of a normal run. Copy earlier output or storage elsewhere before starting if you need to preserve it.

## Latest verified run

The output generated on 17 October 2026 was checked successfully:

- 50 unique places exported and 0 failed requests
- 26 results from `cafes` and 24 from `drink`
- 42 places with structured menus, containing 2,338 dishes
- 38 places with valid Popular-times charts, containing 4,777 hourly readings
- 1,500 unique photos: 30 per place, all with photo IDs, full-size URLs, tab information, width, and height
- CSV contains one header and 50 balanced, valid data rows

The record timestamps span approximately 1 hour 47 minutes. Discovery and
startup time may make the complete command runtime slightly longer.

## Known limitations

- Google Maps is a dynamic, frequently changing JavaScript application. Selectors may need maintenance when Google changes its interface.
- Menus are loaded lazily and can be virtualized. The scraper scrolls each category and waits for content, but Google may occasionally omit a dish during a run because of delayed loading, network timing, experiments, or rate limiting. Running the affected restaurant again may return the missing dish.
- Only genuine structured dishes from the Google Maps Menu tab are collected. Menu photos, external restaurant websites, PDFs, Facebook pages, and delivery platforms are not interpreted.
- Some places publish dish names without descriptions or prices. Missing price values remain `null`. A current extraction issue can repeat the displayed price in `description` when Google provides no separate description; consumers should treat a description identical to `priceText` as missing until this is corrected.
- `priceText` preserves Google's displayed value. `priceValue` is parsed only from an explicit single price. Price ranges and missing prices produce a `null` numeric value. Currency is recorded only when Google displays an explicit symbol or code.
- Ratings and per-person price ranges are collected only when Google displays them on the place page.
- Popular-times data is `null` when Google does not publish the chart or the chart does not load. It represents relative busyness percentages, not actual visitor counts.
- `MAX_PLACES` is an upper limit, not a guarantee. Google controls how many results are available for a query and area.
- The scraper uses low concurrency and does not bypass CAPTCHAs or implement aggressive anti-bot evasion.

For production or commercial integrations, consider the official Google Places API. Confirm that your collection and use comply with Google Maps terms and applicable privacy and data-protection laws.
