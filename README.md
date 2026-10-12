# Google Maps restaurant scraper with Crawlee

A Crawlee and Playwright scraper for collecting public restaurant information from Google Maps. It can search one or many Kuala Lumpur areas, distribute the final place limit fairly across those areas, visit each restaurant, and export JSON and CSV files.

## Current capabilities

The scraper collects:

- restaurant name and category
- rating from 1 to 5 and review count
- displayed per-person price range, such as `RM 20–40 per person`, when Google provides one
- address, phone number, website, and plus code
- latitude and longitude
- weekly opening hours
- Google Maps menu categories and dishes
- peak hours derived from Google Maps popular-time percentages
- structured information from the About tab, including service options, accessibility, offerings, dining options, amenities, atmosphere, planning, and payments
- a grouped `contact` object containing phone, website, and address
- Google Maps URL, source query, search area, and scrape timestamp

For every structured menu dish, the scraper returns:

- `name`
- `description`
- `priceText`: the price exactly as displayed by Google
- `priceValue`: a numeric value only when Google shows one explicit price
- `currency`: normalized currency code when an explicit currency is present

Menu categories are opened individually. Dish information is read from the active Google Maps Menu region, and duplicate copies are merged by category and dish name. Missing menu fields remain `null`; the scraper never estimates or invents prices.

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
AREA=Kuala Lumpur, Malaysia
MAX_PLACES=1000
MAX_CANDIDATES_PER_AREA=150
AREAS=Kuala Lumpur City Centre|Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur
MAX_STALLED_SCROLLS=12
SCROLL_WAIT_MS=2000
HEADLESS=false
CHROME_PROFILE_DIR=.chrome-profile
```

### Configuration reference

| Setting | Meaning |
| --- | --- |
| `QUERY` | Google Maps search phrase, such as `restaurants` or `halal restaurants`. An exact restaurant name is also supported. |
| `AREA` | Single fallback search area. Used only when `AREAS` is empty or unset. |
| `AREAS` | Multiple search areas separated by `\|`. This takes precedence over `AREA`. |
| `MAX_PLACES` | Shared maximum number of restaurants in the final output, not a per-area limit. |
| `MAX_CANDIDATES_PER_AREA` | Maximum discovery candidates collected from each configured area before final selection. |
| `MAX_STALLED_SCROLLS` | Number of result-list scrolls with no new places before discovery stops. |
| `SCROLL_WAIT_MS` | Delay between result-list scrolls, in milliseconds. Increase it for slow connections. |
| `HEADLESS` | Keep this `false` for the most complete Google Maps and Menu interface. |
| `CHROME_PROFILE_DIR` | Dedicated signed-in Chrome profile used by login and scraping. |
| `CHROME_PATH` | Optional path to Chrome when it is installed in a non-standard location. |

`MAX_PLACES` is shared across all areas. Discovery completes for every area first, then a deduplicated round-robin selection gives each area a fair opportunity to contribute restaurants. For example, `MAX_PLACES=100` means up to 100 total restaurants, not 100 from every area.

Smaller districts normally provide better coverage than one broad Kuala Lumpur search. Increase `MAX_CANDIDATES_PER_AREA` if an area can provide more candidates and you want it to participate more deeply in the final selection.

## Running the scraper

Run with the settings in `.env`:

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

Crawlee also keeps its local dataset under `storage/datasets/default/`. Nested fields such as `menu`, `openingHours`, `peakHours`, `about`, and `contact` are stored as JSON strings inside the CSV.

Progress logs include:

- discovered candidate totals for each area
- selected totals for each area
- per-restaurant scrape duration
- rating, review count, contact details, and menu item count
- failures and retries
- total elapsed time and exported record count

Crawlee purges its default local storage at the beginning of a normal run. Copy earlier output or storage elsewhere before starting if you need to preserve it.

## Known limitations

- Google Maps is a dynamic, frequently changing JavaScript application. Selectors may need maintenance when Google changes its interface.
- Menus are loaded lazily and can be virtualized. The scraper scrolls each category and waits for content, but Google may occasionally omit a dish during a run because of delayed loading, network timing, experiments, or rate limiting. Running the affected restaurant again may return the missing dish.
- Only genuine structured dishes from the Google Maps Menu tab are collected. Menu photos, external restaurant websites, PDFs, Facebook pages, and delivery platforms are not interpreted.
- Some restaurants publish dish names without descriptions or prices. Those values correctly remain `null`.
- `priceText` preserves Google's displayed value. `priceValue` is parsed only from an explicit single price. Price ranges and missing prices produce a `null` numeric value. Currency is recorded only when Google displays an explicit symbol or code.
- Ratings and per-person price ranges are collected only when Google displays them on the place page.
- `MAX_PLACES` is an upper limit, not a guarantee. Google controls how many results are available for a query and area.
- The scraper uses low concurrency and does not bypass CAPTCHAs or implement aggressive anti-bot evasion.

For production or commercial integrations, consider the official Google Places API. Confirm that your collection and use comply with Google Maps terms and applicable privacy and data-protection laws.
