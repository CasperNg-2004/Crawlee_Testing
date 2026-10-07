# Google Maps restaurant scraper with Crawlee

This starter uses Crawlee and Playwright to search Google Maps, scroll the result list, open each restaurant page, and export public business details.

It collects:

- name and category
- rating and review count
- price level
- address, phone, website, and plus code
- latitude and longitude
- opening hours
- menu availability/link, where Maps exposes one
- peak hours derived from Google Maps busy-time percentages, where available
- structured information from the About tab, grouped by sections such as service options, accessibility, offerings, amenities, and payments
- a grouped contact object containing phone, website, and address
- Google Maps URL and scrape timestamp

## Setup

Node.js 20 or newer is recommended.

```powershell
npm install
npx playwright install chromium
```

Run the search using settings from `.env`:

```powershell
npm start
```

Show the browser while developing:

```powershell
npm run start:visible
```

Change the search permanently by editing `.env`. `AREAS` accepts several locations separated by `|`; searching smaller districts gives better coverage than one broad Maps search. Duplicate listing URLs are removed automatically.

```dotenv
QUERY=restaurants
MAX_PLACES=1000
AREAS=Kuala Lumpur City Centre|Bukit Bintang, Kuala Lumpur|Bangsar, Kuala Lumpur
MAX_STALLED_SCROLLS=12
SCROLL_WAIT_MS=2000
```

You can also override a setting for one run from PowerShell:

```powershell
$env:QUERY = 'halal restaurants'
$env:AREA = 'Bukit Bintang, Kuala Lumpur'
$env:MAX_PLACES = '50'
npm start
```

The final files are:

- `output/restaurants.json`
- `output/restaurants.csv`

Crawlee also keeps its local dataset under `storage/datasets/default/`.

## Notes

- Google Maps is a JavaScript application, so this uses `PlaywrightCrawler` rather than an HTML-only crawler.
- `MAX_PLACES` is an upper limit, not a guarantee. Google Maps decides how many results exist for each search. Add relevant districts to `AREAS` to improve coverage.
- Progress logs include discovery totals, per-place scrape duration and business details, failures, and the final elapsed time.
- Menu, peak-hour, and About information is not published for every restaurant. Missing information is returned as `null`, `false`, an empty array, or an empty object rather than guessed.
- Page structure and selectors can change. Run with `HEADLESS=false` to inspect a failed page and update selectors if needed.
- This intentionally uses low concurrency and does not include CAPTCHA bypassing or aggressive anti-bot evasion.
- For a production or commercial integration, prefer the official Google Places API. Confirm that your collection and use comply with Google Maps terms and applicable privacy/data laws.
- Crawlee purges the default local storage at the beginning of a normal run. Copy earlier outputs elsewhere first if you want to keep them.
