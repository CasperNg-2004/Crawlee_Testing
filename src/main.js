import { mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log } from 'crawlee';

// PowerShell truncates Format-Table output to the terminal width on Windows.
// Crawlee expects the complete `WorkingSetSize` process-list header.
if (process.platform === 'win32') process.env.COLUMNS = '200';

const query = process.env.QUERY?.trim() || 'restaurant';
const area = process.env.AREA?.trim() || 'Kuala Lumpur, Malaysia';
const maxPlaces = positiveInteger(process.env.MAX_PLACES, 1000);
const maxStalledScrolls = positiveInteger(process.env.MAX_STALLED_SCROLLS, 12);
const scrollWaitMs = positiveInteger(process.env.SCROLL_WAIT_MS, 2_000);
const headless = process.env.HEADLESS?.toLowerCase() !== 'false';
const outputDir = process.env.OUTPUT_DIR?.trim() || 'output';
const chromeProfileDir = resolve(process.env.CHROME_PROFILE_DIR?.trim() || '.chrome-profile');
const areas = (process.env.AREAS?.trim() || area)
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const maxCandidatesPerArea = positiveInteger(process.env.MAX_CANDIDATES_PER_AREA, 150);
const scrapePhotos = booleanValue(process.env.SCRAPE_PHOTOS, false);
const photoTabs = (process.env.PHOTO_TABS?.trim() || 'All|Menu|By owner')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const photoMaxPerPlace = positiveInteger(process.env.PHOTO_MAX_PER_PLACE, 30);
const photoScanLimit = Math.max(
  photoMaxPerPlace,
  positiveInteger(process.env.PHOTO_SCAN_LIMIT, photoMaxPerPlace),
);
const photoScrollRounds = positiveInteger(process.env.PHOTO_SCROLL_ROUNDS, 120);
const photoCaptureUploadDate = booleanValue(process.env.PHOTO_CAPTURE_UPLOAD_DATE, true);
const directPlaceUrls = (process.env.PLACE_URLS?.trim() || '')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const maxRequestsPerCrawl = positiveInteger(process.env.MAX_REQUESTS_PER_CRAWL, undefined);
const maxRequestRetries = 2;
const browserPageBudget = ((areas.length + maxPlaces) * (maxRequestRetries + 1)) + 100;
const runStartedAt = Date.now();

let queuedPlaceCount = 0;
let successfulPlaceCount = 0;
let failedPlaceCount = 0;
let detailRequestsQueued = false;
const areaCandidates = new Map();
const failedRestaurantRecords = [];

const router = createPlaywrightRouter();

router.addHandler('SEARCH', async ({ page, request, addRequests, log: requestLog }) => {
  await acceptConsentIfShown(page);

  const feed = page.locator('div[role="feed"]');
  const placeUrls = new Set();
  await page.waitForFunction(() => {
    const isVisible = (element) => Boolean(element && element.getBoundingClientRect().width
      && element.getBoundingClientRect().height);
    return isVisible(document.querySelector('div[role="feed"]'))
      || isVisible(document.querySelector('main h1, div[role="main"] h1'));
  }, { timeout: 30_000 });

  if (!await feed.isVisible().catch(() => false)) {
    const directPlaceHeading = page.locator('div[role="main"] h1').first();
    if (!await directPlaceHeading.isVisible().catch(() => false)) {
      throw new Error('Google Maps loaded neither a search results feed nor a direct place page.');
    }
    placeUrls.add(cleanPlaceUrl(page.url()));
    requestLog.info(`Exact search opened a direct place result for ${request.userData.area}.`);
  }

  let unchangedRounds = 0;

  while (await feed.isVisible().catch(() => false)
    && placeUrls.size < maxCandidatesPerArea && unchangedRounds < maxStalledScrolls) {
    const before = placeUrls.size;
    const urls = await feed.locator('a[href*="/maps/place/"]').evaluateAll((links) =>
      links.map((link) => link.href),
    );

    for (const url of urls) {
      const cleanedUrl = cleanPlaceUrl(url);
      placeUrls.add(cleanedUrl);
      if (placeUrls.size >= maxCandidatesPerArea) break;
    }

    const endOfList = await feed.getByText(/reached the end of the list/i).isVisible().catch(() => false);
    if (endOfList) {
      requestLog.info(`Reached the end of results for ${request.userData.area}; found ${placeUrls.size} new places.`);
      break;
    }

    unchangedRounds = placeUrls.size === before ? unchangedRounds + 1 : 0;
    const links = feed.locator('a[href*="/maps/place/"]');
    const linkCount = await links.count();
    if (linkCount > 0) await links.nth(linkCount - 1).scrollIntoViewIfNeeded();
    await feed.evaluate((element) => element.scrollBy(0, Math.max(element.clientHeight, 800)));
    await page.waitForTimeout(scrollWaitMs);

    if (placeUrls.size > before) {
      requestLog.info(`Discovery progress for ${request.userData.area}: ${placeUrls.size} new places.`);
    }
  }

  areaCandidates.set(request.userData.area, [...placeUrls]);
  requestLog.info(`Discovery finished for ${request.userData.area}: ${placeUrls.size} candidates stored.`);
  await queueDetailsWhenDiscoveryComplete(addRequests);
});

router.addHandler('DETAIL', async ({ page, request, pushData, log: requestLog }) => {
  await acceptConsentIfShown(page);
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  const initialHeading = await page.locator('h1').first().innerText().catch(() => '');
  if (/can't reach the internet|something went wrong|no internet/i.test(initialHeading)) {
    throw new Error(`Google Maps error page: ${initialHeading}`);
  }

  // Capture header values before scrolling. Google Maps virtualizes the top of the
  // details panel, so rating/review/price-range elements may disappear afterwards.
  const headerSummary = await page.locator('div[role="main"]').first().evaluate((main) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const header = main.querySelector('.TIHn2') || main;
    const ratingLabel = clean(header.querySelector('[aria-label*="star" i]')?.getAttribute('aria-label'));
    const parsedRating = Number(ratingLabel?.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.'));
    const rating = Number.isFinite(parsedRating) && parsedRating >= 1 && parsedRating <= 5
      ? parsedRating
      : null;
    const headerText = clean(header.textContent) || '';
    const reviewMatch = headerText.match(/\(([\d,.\s]+)\)/);
    const reviewCount = reviewMatch
      ? Number(reviewMatch[1].replace(/[^\d]/g, '')) || null
      : null;
    const priceCandidates = [...main.querySelectorAll('[aria-label*="price range" i], .MNVeJb')];
    const pricePattern = /(?:RM|MYR|USD|US\$|SGD|S\$|EUR|GBP|JPY|CNY|RMB|AUD|CAD|THB|IDR|PHP|INR|[$€£¥₹₩฿₱])\s*\d[\d.,]*\s*[-–—]\s*(?:(?:RM|MYR|USD|US\$|SGD|S\$|EUR|GBP|JPY|CNY|RMB|AUD|CAD|THB|IDR|PHP|INR|[$€£¥₹₩฿₱])\s*)?\d[\d.,]*(?:\s+per person)?/i;
    let priceLevel = null;

    for (const element of priceCandidates) {
      const source = clean(element.textContent) || clean(element.getAttribute('aria-label'));
      const match = source?.match(pricePattern);
      if (!match) continue;
      priceLevel = clean(match[0]);
      if (/per person/i.test(priceLevel)) break;
    }

    return { rating, reviewCount, priceLevel };
  }).catch(() => ({ rating: null, reviewCount: null, priceLevel: null }));

  const hoursExpander = page.getByLabel(/show open hours for the week/i).first();
  if (await hoursExpander.isVisible().catch(() => false)) {
    await hoursExpander.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Scroll the details panel so Maps lazy-loads sections such as Popular times.
  const detailsPanel = page.locator('div[role="main"]').first();
  if (await detailsPanel.isVisible().catch(() => false)) {
    for (let index = 0; index < 5; index += 1) {
      await detailsPanel.evaluate((element) => element.scrollBy(0, 900)).catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  const canonicalUrl = page.url();
  const coordinates = coordinatesFromUrl(canonicalUrl);
  const details = await page.evaluate(() => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const unique = (values) => [...new Set(values.filter(Boolean))];
    const text = (selector) => clean(document.querySelector(selector)?.textContent);
    const aria = (selector) => clean(document.querySelector(selector)?.getAttribute('aria-label'));
    const itemText = (prefix) => {
      const element = document.querySelector(`[data-item-id^="${prefix}"]`);
      return clean(element?.getAttribute('aria-label') || element?.textContent);
    };
    const stripLabel = (value, labels) => {
      if (!value) return null;
      for (const label of labels) {
        value = value.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '');
      }
      return clean(value);
    };

    const ariaLabels = [...document.querySelectorAll('[aria-label]')]
      .map((element) => clean(element.getAttribute('aria-label')))
      .filter(Boolean);
    const websiteElement = document.querySelector('a[data-item-id="authority"]');
    const category = text('button[jsaction*="category"]') || text('button.DkEaL');
    const hours = [...document.querySelectorAll('table.eK4R0e tr')].map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => clean(cell.textContent)).filter(Boolean);
      return cells.length >= 2 ? { day: cells[0], hours: cells.slice(1).join(' ') } : null;
    }).filter(Boolean);
    const popularTimeLabels = unique(ariaLabels.filter((label) =>
      /popular times|usually.+busy|currently.+busy|as busy as it gets|\b\d{1,3}% busy\b/i.test(label),
    ));

    return {
      name: text('h1'),
      category,
      address: stripLabel(itemText('address'), ['Address']),
      phone: stripLabel(itemText('phone'), ['Phone']),
      website: websiteElement?.href || null,
      plusCode: stripLabel(itemText('oloc'), ['Plus code']),
      openingHours: hours,
      popularTimeLabels,
    };
  });
  Object.assign(details, headerSummary);

  const peakHours = derivePeakHours(details.popularTimeLabels);
  delete details.popularTimeLabels;
  const menu = await extractGoogleMenu(page);
  const about = await extractAbout(page);
  const photoResult = scrapePhotos
    ? await extractGooglePhotos(page, canonicalUrl, requestLog)
    : { photos: null, photoScrape: null };
  if (photoResult.photoScrape?.status === 'failed' && request.retryCount < maxRequestRetries) {
    const failedTabs = Object.entries(photoResult.photoScrape.tabs)
      .filter(([, result]) => result.status === 'failed')
      .map(([tab]) => tab)
      .join(', ');
    throw new Error(`Photo scrape failed for ${failedTabs || 'unknown tab'}; retrying restaurant.`);
  }
  if (photoResult.photoScrape) {
    photoResult.photoScrape.requestAttempts = request.retryCount + 1;
  }

  const record = {
    ...details,
    menu,
    photos: photoResult.photos,
    photoScrape: photoResult.photoScrape,
    peakHours,
    about,
    contact: {
      phone: details.phone,
      website: details.website,
      address: details.address,
    },
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    googleMapsUrl: canonicalUrl,
    query: request.userData.query,
    area: request.userData.area,
    scrapedAt: new Date().toISOString(),
  };

  await pushData(record);
  successfulPlaceCount += 1;
  const elapsedMs = Date.now() - (request.userData.startedAt ?? Date.now());
  requestLog.info(
    `[${successfulPlaceCount}/${queuedPlaceCount}] Scraped in ${formatDuration(elapsedMs)}: ${record.name ?? 'Unknown place'}`,
    {
      category: record.category,
      rating: record.rating,
      reviewCount: record.reviewCount,
      address: record.address,
      searchArea: record.area,
      phone: record.phone,
      website: record.website,
      menuItemCount: countMenuItems(record.menu),
      photoCount: record.photos?.length ?? 0,
      photoScrapeStatus: record.photoScrape?.status ?? null,
      openingHours: record.openingHours,
      peakHours: record.peakHours,
      about: record.about,
      url: canonicalUrl,
    },
  );
});

const crawler = new PlaywrightCrawler({
  requestHandler: router,
  headless,
  launchContext: {
    useIncognitoPages: false,
    userDataDir: chromeProfileDir,
    launchOptions: {
      channel: 'chrome',
      args: ['--disable-background-mode'],
    },
  },
  browserPoolOptions: {
    retireBrowserAfterPageCount: browserPageBudget,
  },
  sessionPoolOptions: {
    sessionOptions: {
      maxUsageCount: browserPageBudget,
    },
  },
  // Photo galleries are memory-heavy and this scraper uses one persistent Chrome
  // profile. Keep photo runs single-page so Chrome is less likely to crash and
  // leave the profile locked during a Crawlee browser relaunch.
  maxConcurrency: (directPlaceUrls.length || scrapePhotos) ? 1 : 2,
  maxRequestsPerCrawl,
  maxRequestRetries,
  requestHandlerTimeoutSecs: scrapePhotos ? 900 : 180,
  navigationTimeoutSecs: 45,
  preNavigationHooks: [async ({ page, request }) => {
    request.userData.startedAt = Date.now();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-MY,en;q=0.9' });
  }],
  failedRequestHandler: async ({ request, error, addRequests, log: requestLog }) => {
    const elapsedMs = Date.now() - (request.userData.startedAt ?? Date.now());
    if (request.label === 'DETAIL') {
      failedPlaceCount += 1;
      failedRestaurantRecords.push({
        googleMapsUrl: request.url,
        query: request.userData.query ?? query,
        area: request.userData.area ?? null,
        status: 'failed',
        stage: 'restaurant-page',
        attempts: request.retryCount + 1,
        error: error?.message || 'Request failed after all retries',
        failedAt: new Date().toISOString(),
      });
    } else if (request.label === 'SEARCH') {
      areaCandidates.set(request.userData.area, []);
      await queueDetailsWhenDiscoveryComplete(addRequests);
    }
    requestLog.error(`Failed after retries in ${formatDuration(elapsedMs)}: ${request.url}`, {
      label: request.label,
      searchArea: request.userData.area,
      retryCount: request.retryCount,
    });
  },
});

const searchRequests = areas.map((searchArea) => ({
  url: buildSearchUrl(query, searchArea),
  label: 'SEARCH',
  uniqueKey: `search:${query}:${searchArea}`,
  userData: { area: searchArea },
}));

const initialRequests = directPlaceUrls.length
  ? directPlaceUrls.slice(0, maxPlaces).map((url, index) => ({
    url,
    label: 'DETAIL',
    uniqueKey: `direct-place:${index}:${url}`,
    userData: { area: 'Direct input', query },
  }))
  : searchRequests;
if (directPlaceUrls.length) {
  detailRequestsQueued = true;
  queuedPlaceCount = initialRequests.length;
  log.info(`Scraping ${queuedPlaceCount} direct Google Maps place URL(s).`);
} else {
  log.info(`Searching for "${query}" across ${areas.length} area(s), up to ${maxPlaces} unique places.`);
}
log.info(`Using the dedicated Chrome profile at ${chromeProfileDir}. Run \`npm run login\` if Maps requests sign-in.`);
log.info(`Keeping one Chrome session for up to ${browserPageBudget} page uses to avoid profile-lock relaunches.`);
if (maxRequestsPerCrawl) {
  log.info(`This process will stop cleanly after at most ${maxRequestsPerCrawl} requests for controlled batching.`);
}
await crawler.run(initialRequests);

const dataset = await Dataset.getData({ limit: maxPlaces });
await mkdir(outputDir, { recursive: true });
await writeFileAtomic(`${outputDir}/restaurants.json`, `${JSON.stringify(dataset.items, null, 2)}\n`);
await writeFileAtomic(`${outputDir}/restaurants.csv`, toCsv(dataset.items));
await writeFileAtomic(
  `${outputDir}/failed-restaurants.json`,
  `${JSON.stringify(failedRestaurantRecords, null, 2)}\n`,
);
log.info(
  `Finished in ${formatDuration(Date.now() - runStartedAt)}. `
  + `Scraped ${successfulPlaceCount}/${queuedPlaceCount} places successfully; ${failedPlaceCount} failed. `
  + `Exported ${dataset.items.length} records to ${outputDir}/restaurants.json and ${outputDir}/restaurants.csv.`,
);

// Crawlee leaves its Chrome version-probe child alive with persistent contexts on Windows.
// All crawler teardown and output writes are complete here, so exit cleanly and release the profile.
process.exit(0);

async function writeFileAtomic(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, 'utf8');
  await rename(temporaryPath, filePath);
}

async function acceptConsentIfShown(page) {
  const candidates = [
    page.getByRole('button', { name: /accept all/i }),
    page.getByRole('button', { name: /agree/i }),
  ];

  for (const candidate of candidates) {
    if (await candidate.first().isVisible().catch(() => false)) {
      await candidate.first().click();
      await page.waitForTimeout(750);
      return;
    }
  }
}

function cleanPlaceUrl(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildSearchUrl(searchQuery, searchArea) {
  return `https://www.google.com/maps/search/${encodeURIComponent(`${searchQuery} in ${searchArea}`)}?hl=en`;
}

async function queueDetailsWhenDiscoveryComplete(addRequests) {
  if (detailRequestsQueued || areaCandidates.size < areas.length) return;
  detailRequestsQueued = true;

  const detailRequests = selectFairCandidates(areaCandidates, areas, maxPlaces, query);
  queuedPlaceCount = detailRequests.length;
  logDiscoverySummary(areaCandidates, areas, detailRequests);
  log.info(`Fair round-robin selection queued ${queuedPlaceCount} unique places for detail scraping.`);

  if (detailRequests.length) await addRequests(detailRequests);
}

function selectFairCandidates(candidatesByArea, areaOrder, limit, searchQuery) {
  const cursors = new Map(areaOrder.map((searchArea) => [searchArea, 0]));
  const seenPlaces = new Set();
  const selected = [];

  while (selected.length < limit) {
    let selectedThisRound = 0;

    for (const searchArea of areaOrder) {
      if (selected.length >= limit) break;
      const candidates = candidatesByArea.get(searchArea) || [];
      let cursor = cursors.get(searchArea) || 0;

      while (cursor < candidates.length) {
        const url = candidates[cursor];
        cursor += 1;
        const identity = placeIdentity(url);
        if (seenPlaces.has(identity)) continue;

        seenPlaces.add(identity);
        selected.push({
          url,
          uniqueKey: identity,
          label: 'DETAIL',
          userData: {
            searchUrl: buildSearchUrl(searchQuery, searchArea),
            query: searchQuery,
            area: searchArea,
          },
        });
        selectedThisRound += 1;
        break;
      }

      cursors.set(searchArea, cursor);
    }

    if (selectedThisRound === 0) break;
  }

  return selected;
}

function placeIdentity(url) {
  const googlePlaceId = url.match(/!19s([^!/?]+)/)?.[1];
  if (googlePlaceId) return `place-id:${decodeURIComponent(googlePlaceId)}`;

  const dataId = url.match(/!1s([^!/?]+)/)?.[1];
  if (dataId) return `data-id:${decodeURIComponent(dataId)}`;

  return cleanPlaceUrl(url);
}

function logDiscoverySummary(candidatesByArea, areaOrder, selectedRequests) {
  const selectedCounts = new Map(areaOrder.map((searchArea) => [searchArea, 0]));
  for (const request of selectedRequests) {
    const searchArea = request.userData.area;
    selectedCounts.set(searchArea, (selectedCounts.get(searchArea) || 0) + 1);
  }

  for (const searchArea of areaOrder) {
    log.info(`Area allocation: ${searchArea}`, {
      discovered: candidatesByArea.get(searchArea)?.length || 0,
      selected: selectedCounts.get(searchArea) || 0,
    });
  }
}

async function extractGoogleMenu(page) {
  const menuTabs = page.locator('[role="tab"]').filter({ hasText: /^\s*Menu\s*$/i });
  let menuTab = null;

  for (let index = 0; index < await menuTabs.count(); index += 1) {
    const candidate = menuTabs.nth(index);
    const ariaLabel = await candidate.getAttribute('aria-label');
    if (await candidate.isVisible().catch(() => false) && /^menu\b/i.test(ariaLabel || 'Menu')) {
      menuTab = candidate;
      break;
    }
  }

  if (!menuTab) return null;

  await menuTab.click().catch(() => {});
  await menuTab.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(1_250);

  const panel = page.locator('div[role="main"]').first();
  if (!await panel.isVisible().catch(() => false)) return null;
  const categoryNames = await getMenuCategoryNames(page);
  const categoriesToScrape = categoryNames.length ? categoryNames : [null];
  const rawItems = [];

  for (const categoryName of categoriesToScrape) {
    if (categoryName) {
      const clicked = await clickMenuCategory(page, categoryName);
      if (!clicked) continue;
      await page.waitForTimeout(400);
    }

    await scrollDetailsPanel(panel);
    rawItems.push(...await extractVisibleMenuRows(panel, categoryName, categoryNames));
  }

  const normalizedItems = rawItems
    .map(normalizeMenuItem)
    .filter(Boolean);
  const uniqueItems = [];
  const itemIndexes = new Map();

  for (const item of normalizedItems) {
    const key = `${item.section || ''}\u0000${item.name}`.toLowerCase();
    const existingIndex = itemIndexes.get(key);
    if (existingIndex === undefined) {
      itemIndexes.set(key, uniqueItems.length);
      uniqueItems.push(item);
      continue;
    }

    const existing = uniqueItems[existingIndex];
    uniqueItems[existingIndex] = {
      ...existing,
      description: chooseMoreCompleteText(existing.description, item.description),
      priceText: existing.priceText || item.priceText,
      priceValue: existing.priceValue ?? item.priceValue,
      currency: existing.currency || item.currency,
    };
  }

  if (!uniqueItems.length) return null;

  const sections = [];
  for (const item of uniqueItems) {
    let section = sections.find(({ name }) => name === item.section);
    if (!section) {
      section = { name: item.section, items: [] };
      sections.push(section);
    }
    const { section: ignoredSection, ...dish } = item;
    section.items.push(dish);
  }

  return { source: 'google_maps', sections };
}

async function getMenuCategoryNames(page) {
  return page.locator('[role="tab"]').evaluateAll((tabs) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const visibleTabs = tabs.filter((tab) => {
      const box = tab.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    const groups = new Map();

    for (const tab of visibleTabs) {
      const group = tab.closest('[role="tablist"]') || tab.parentElement?.parentElement;
      if (!group) continue;
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(tab);
    }

    const topNavigation = /^(menu|reviews?|photos?|updates?|about)$/i;
    const categoryGroup = [...groups.values()]
      .map((groupTabs) => groupTabs.map((tab) => clean(tab.textContent)).filter(Boolean))
      .filter((names) => names.length > 1 && names.some((name) => /^overview$/i.test(name)))
      .filter((names) => !names.some((name) => topNavigation.test(name)))
      .sort((left, right) => right.length - left.length)[0] || [];

    return [...new Set(categoryGroup.filter((name) => !/^overview$/i.test(name)))];
  });
}

async function clickMenuCategory(page, categoryName) {
  const candidates = page.locator('[role="tab"]').filter({
    hasText: new RegExp(`^\\s*${escapeRegExp(categoryName)}\\s*$`, 'i'),
  });

  for (let index = 0; index < await candidates.count(); index += 1) {
    const candidate = candidates.nth(index);
    const ariaLabel = (await candidate.getAttribute('aria-label') || '').trim();
    if (ariaLabel.toLowerCase() !== categoryName.toLowerCase()
      || !await candidate.isVisible().catch(() => false)) continue;
    await candidate.click().catch(() => {});
    await candidate.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => {});
    await page.waitForFunction(
      (name) => [...document.querySelectorAll('[role="tab"]')].some((tab) =>
        tab.getAttribute('aria-label')?.trim().toLowerCase() === name.toLowerCase()
        && tab.getAttribute('aria-selected') === 'true'),
      categoryName,
      { timeout: 5_000 },
    ).catch(() => {});
    return true;
  }

  return false;
}

async function scrollDetailsPanel(panel) {
  let previousHeight = 0;
  let stalledRounds = 0;
  while (stalledRounds < 3) {
    const height = await panel.evaluate((element) => element.scrollHeight).catch(() => previousHeight);
    await panel.evaluate((element) => element.scrollTo(0, element.scrollHeight)).catch(() => {});
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
    stalledRounds = height === previousHeight ? stalledRounds + 1 : 0;
    previousHeight = height;
  }
}

async function extractVisibleMenuRows(panel, categoryName, categoryNames) {
  return panel.evaluate((main, input) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const linesOf = (element) => (element.innerText || '')
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);
    const ignored = /^(overview|menu|about|reviews?|photos?|order online|directions|save|nearby|share|popular|secure your spot)$/i;
    const ignoredCategories = new Set(input.categoryNames.map((name) => name.toLowerCase()));
    const menuRegion = [...main.querySelectorAll('[role="region"][aria-label]')]
      .find((element) => /^menu$/i.test(clean(element.getAttribute('aria-label')) || ''));
    if (!menuRegion) return [];

    const rows = new Set();
    for (const nameElement of menuRegion.querySelectorAll('.Io6YTe.kR99db')) {
      const row = nameElement.closest('.m6QErb.Pf6ghf')
        || nameElement.closest('[role="row"], [role="listitem"], article, li');
      if (row) rows.add(row);
    }

    return [...rows].map((row) => {
      const name = clean(row.querySelector('.Io6YTe.kR99db')?.textContent);
      const description = clean(row.querySelector('.gSkmPd.DshQNd, .gSkmPd')?.textContent);
      const displayedPrice = clean(row.querySelector('.sErS0c.Eos3sd, .sErS0c')?.textContent);
      const box = row.getBoundingClientRect();
      if (!name || box.width <= 0 || box.height <= 0 || ignored.test(name)
        || ignoredCategories.has(name.toLowerCase())) return null;
      return {
        section: input.categoryName,
        name,
        description,
        displayedPrice,
        lines: linesOf(row),
      };
    }).filter(Boolean);
  }, { categoryName, categoryNames });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeMenuItem(rawItem) {
  const lines = rawItem.lines
    .map((line) => line.trim())
    .filter((line) => line && !/^popular$/i.test(line));
  if (!lines.length) return null;

  const price = rawItem.displayedPrice
    ? extractDisplayedPrice([rawItem.displayedPrice], true)
    : extractDisplayedPrice(lines);
  const contentLines = lines.filter((_, index) => index !== price.lineIndex);
  const name = rawItem.name || contentLines.shift() || null;
  if (!name) return null;

  const inferredDescription = contentLines
    .filter((line) => line.toLowerCase() !== name.toLowerCase())
    .join(' ') || null;

  return {
    section: rawItem.section || null,
    name,
    description: rawItem.description || inferredDescription,
    priceText: price.priceText,
    priceValue: price.priceValue,
    currency: price.currency,
  };
}

function chooseMoreCompleteText(left, right) {
  if (!left) return right || null;
  if (!right) return left;
  return right.length > left.length ? right : left;
}

function extractDisplayedPrice(lines, allowNumericOnly = false) {
  const currencyPattern = '(?:RM|MYR|USD|US\\$|SGD|S\\$|EUR|GBP|JPY|CNY|RMB|AUD|CAD|THB|IDR|PHP|INR|[$€£¥₹₩฿₱])';
  const pricedValue = new RegExp(`(${currencyPattern}\\s*\\d[\\d.,]*(?:\\s*[-–—]\\s*(?:${currencyPattern}\\s*)?\\d[\\d.,]*)?)`, 'i');
  const numericOnly = /^\d[\d.,]*(?:\s*[-–—]\s*\d[\d.,]*)?$/;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex];
    const match = line.match(pricedValue)
      || (allowNumericOnly && numericOnly.test(line) ? [line, line] : null);
    if (!match) continue;

    const priceText = match[1].trim();
    const currencyToken = priceText.match(new RegExp(currencyPattern, 'i'))?.[0] || null;
    const isRange = /\d[\d.,]*\s*[-–—]\s*(?:\D*\s*)?\d/.test(priceText);
    const numericText = priceText.match(/\d[\d.,]*/)?.[0] || null;

    return {
      lineIndex,
      priceText,
      priceValue: isRange ? null : parseExplicitNumber(numericText),
      currency: normalizeCurrency(currencyToken),
    };
  }

  return { lineIndex: -1, priceText: null, priceValue: null, currency: null };
}

function parseExplicitNumber(value) {
  if (!value) return null;
  let normalized = value;
  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = normalized.replaceAll(thousandsSeparator, '').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    const decimalDigits = normalized.length - lastComma - 1;
    normalized = decimalDigits === 2 ? normalized.replace(',', '.') : normalized.replaceAll(',', '');
  } else if (lastDot >= 0) {
    const decimalDigits = normalized.length - lastDot - 1;
    if (decimalDigits !== 1 && decimalDigits !== 2) normalized = normalized.replaceAll('.', '');
  }

  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function normalizeCurrency(token) {
  if (!token) return null;
  const value = token.toUpperCase();
  const currencies = {
    RM: 'MYR', MYR: 'MYR', 'US$': 'USD', USD: 'USD', 'S$': 'SGD', SGD: 'SGD',
    EUR: 'EUR', GBP: 'GBP', JPY: 'JPY', CNY: 'CNY', RMB: 'CNY', AUD: 'AUD',
    CAD: 'CAD', THB: 'THB', IDR: 'IDR', PHP: 'PHP', INR: 'INR', '€': 'EUR',
    '£': 'GBP', '¥': '¥', '₹': 'INR', '₩': 'KRW', '฿': 'THB', '₱': 'PHP', '$': '$',
  };
  return currencies[value] ?? token;
}

function countMenuItems(menu) {
  return menu?.sections?.reduce((total, section) => total + section.items.length, 0) ?? 0;
}

async function extractAbout(page) {
  const aboutTab = page.getByRole('tab', { name: /^about\b/i }).first();
  if (await aboutTab.isVisible().catch(() => false)) {
    await aboutTab.click().catch(() => {});
    await page.waitForTimeout(500);
  } else {
    return {};
  }

  return page.locator('div[role="main"]').first().evaluate((main) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const result = {};

    for (const section of main.querySelectorAll('.iP2t7d')) {
      const heading = clean(section.querySelector('h2')?.textContent);
      if (!heading) continue;

      const items = [...section.querySelectorAll('li')].map((item) => {
        const labelElement = item.querySelector('[aria-label]');
        const ariaLabel = clean(labelElement?.getAttribute('aria-label'));
        const name = clean(labelElement?.textContent || item.textContent);
        const icon = item.querySelector('.google-symbols')?.textContent || '';
        let available = null;

        if (/^(has|serves|offers|accepts|provides|allows|welcomes|good for)\b/i.test(ariaLabel || '')) {
          available = true;
        } else if (/^(no|does not|doesn't|not available)\b/i.test(ariaLabel || '')) {
          available = false;
        } else if (icon.codePointAt(0) === 0xE5CA) {
          available = true;
        } else if (icon.codePointAt(0) === 0xE5CD) {
          available = false;
        }

        return name ? { name, available } : null;
      }).filter(Boolean);

      if (items.length) result[heading] = items;
    }

    return result;
  });
}

async function extractGooglePhotos(page, canonicalUrl, requestLog) {
  const photosById = new Map();
  const tabResults = {};

  for (const tab of photoTabs) {
    const tabResult = await collectGooglePhotoTab(page, canonicalUrl, tab);
    tabResults[tab] = {
      status: tabResult.status,
      attempts: tabResult.attempts,
      photoCount: tabResult.photos.length,
      error: tabResult.error,
    };
    for (const photo of tabResult.photos) {
      const existing = photosById.get(photo.photoId);
      if (existing) {
        if (!existing.tabs.includes(tab)) existing.tabs.push(tab);
        if (existing.discoverySource === 'network' && photo.discoverySource === 'dom') {
          existing.discoverySource = 'dom';
          existing.sourceImageUrl = photo.sourceImageUrl;
          existing.photoIndex = photo.photoIndex;
        }
      } else if (photosById.size < photoScanLimit) {
        photosById.set(photo.photoId, { ...photo, tabs: [tab] });
      }
    }
    requestLog.info(
      `Photo tab ${tab}: status=${tabResult.status}, attempts=${tabResult.attempts}, photos=${tabResult.photos.length}.`,
    );
  }

  const candidates = [...photosById.values()];
  const hasFailedTab = Object.values(tabResults).some(({ status }) => status === 'failed');
  const photoScrape = {
    status: hasFailedTab ? 'failed' : candidates.length ? 'success' : 'none',
    tabs: tabResults,
  };
  if (!candidates.length) return { photos: [], photoScrape };

  if (photoCaptureUploadDate) {
    const orderedAllPhotoIds = candidates
      .filter((photo) => photo.tabs.includes('All') && photo.discoverySource === 'dom')
      .sort((left, right) => (left.photoIndex ?? Number.MAX_SAFE_INTEGER)
        - (right.photoIndex ?? Number.MAX_SAFE_INTEGER))
      .map((photo) => photo.photoId);
    const datesById = await collectGooglePhotoDates(page, canonicalUrl, orderedAllPhotoIds).catch((error) => {
      requestLog.warning(`Photo upload dates could not be collected: ${error.message}`);
      return new Map();
    });
    for (const photo of candidates) photo.uploadDate = datesById.get(photo.photoId) ?? null;
  } else {
    for (const photo of candidates) photo.uploadDate = null;
  }

  const photos = candidates
    .map((photo, originalOrder) => ({ photo, originalOrder }))
    .sort((left, right) => photoDateRank(right.photo.uploadDate) - photoDateRank(left.photo.uploadDate)
      || left.originalOrder - right.originalOrder)
    .slice(0, photoMaxPerPlace)
    .map(({ photo }) => photo);

  const probes = await probeFullSizePhotos(page, photos);
  for (let index = 0; index < photos.length; index += 1) {
    const probe = probes[index];
    photos[index].fullSizeImageUrl = probe?.loaded ? probe.url : null;
    photos[index].width = probe?.loaded ? probe.width : null;
    photos[index].height = probe?.loaded ? probe.height : null;
    if (!probe?.loaded) photos[index].imageError = probe?.error || 'Full-size image did not load';
  }

  return { photos, photoScrape };
}

async function collectGooglePhotoTab(page, canonicalUrl, tab) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const photos = await collectGooglePhotoTabOnce(page, canonicalUrl, tab);
      if (photos.length) return { status: 'success', attempts: attempt, photos, error: null };
      if (attempt === 2) return { status: 'none', attempts: attempt, photos: [], error: null };
    } catch (error) {
      lastError = error;
      if (attempt === 2) {
        return { status: 'failed', attempts: attempt, photos: [], error: error.message };
      }
    }
  }
  return {
    status: 'failed',
    attempts: 2,
    photos: [],
    error: lastError?.message || 'Unknown photo-tab failure',
  };
}

async function collectGooglePhotoTabOnce(page, canonicalUrl, tab) {
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await acceptConsentIfShown(page);
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  const heading = await page.locator('h1').first().innerText().catch(() => '');
  if (/can't reach the internet|something went wrong|no internet/i.test(heading)) {
    throw new Error(`Google Maps error page: ${heading}`);
  }
  if (!await openGooglePhotoGallery(page)) return [];

  const networkUrls = new Map();
  const pendingBodies = [];
  let acceptedResponses = 0;
  const responseListener = (response) => {
    const resourceType = response.request().resourceType();
    if (!['xhr', 'fetch'].includes(resourceType)
      || !/google\.[^/]+\/maps/i.test(response.url())
      || acceptedResponses >= 30) return;
    acceptedResponses += 1;
    const pending = response.body().then((body) => {
      if (body.length > 750_000) return;
      for (const source of extractGooglePhotoUrls(body.toString('utf8'))) {
        networkUrls.set(photoIdentity(source), source);
      }
    }).catch(() => {});
    pendingBodies.push(pending);
  };
  page.on('response', responseListener);

  try {
    if (!await clickGooglePhotoTab(page, tab)) return [];
    await page.locator('a.MIgS0d[data-photo-index]').first()
      .waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

    const photosById = new Map();
    let stalledRounds = 0;
    for (let round = 0; round < photoScrollRounds; round += 1) {
      const before = photosById.size;
      const loaded = await describeGoogleGalleryPhotos(page, photoScanLimit);
      for (const photo of loaded) {
        if (!photo.looksLikeVideo && !photosById.has(photo.photoId)) {
          photosById.set(photo.photoId, photo);
        }
      }
      stalledRounds = photosById.size === before ? stalledRounds + 1 : 0;
      if (photosById.size >= photoScanLimit) break;
      const scroll = await scrollGooglePhotoGallery(page);
      if (scroll.atBottom && stalledRounds >= 3) break;
      await page.waitForTimeout(650);
    }

    await Promise.allSettled(pendingBodies);
    for (const [photoId, sourceImageUrl] of networkUrls) {
      if (!photoId || photosById.has(photoId) || photosById.size >= photoScanLimit) continue;
      photosById.set(photoId, {
        photoId,
        sourceImageUrl,
        photoIndex: null,
        discoverySource: 'network',
      });
    }
    return [...photosById.values()];
  } finally {
    page.off('response', responseListener);
  }
}

async function openGooglePhotoGallery(page) {
  const candidates = [
    page.getByRole('tab', { name: /^photos?\b/i }).first(),
    page.locator('button[aria-label^="Photo of" i]').first(),
    page.locator('button[aria-label*="photo" i]').first(),
  ];
  for (const candidate of candidates) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.click();
    await page.waitForTimeout(1_500);
    return true;
  }
  return false;
}

async function clickGooglePhotoTab(page, tab) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(tab)}\\s*$`, 'i');
  const candidates = [
    page.getByRole('tab', { name: pattern }),
    page.getByRole('button', { name: pattern }),
    page.locator('[role="tab"], button').filter({ hasText: pattern }),
  ];
  for (const candidate of candidates) {
    const first = candidate.first();
    if (!await first.isVisible().catch(() => false)) continue;
    await first.click();
    await page.waitForTimeout(1_500);
    return true;
  }
  return false;
}

async function describeGoogleGalleryPhotos(page, limit) {
  return page.evaluate((photoLimit) => {
    const sourceOf = (element) => element?.style.backgroundImage
      .match(/url\(["']?(.*?)["']?\)/)?.[1] || '';
    const results = [];
    const seen = new Set();
    for (const card of document.querySelectorAll('a.MIgS0d[data-photo-index]')) {
      const source = [...card.querySelectorAll('[style*="googleusercontent"]')]
        .map(sourceOf)
        .find((value) => /^https:\/\/lh\d+\.googleusercontent\.com\/(?:p|gps-cs-s)\//.test(value)) || '';
      const photoId = source.match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=]+)/)?.[1] || null;
      if (!photoId || seen.has(photoId)) continue;
      seen.add(photoId);
      const holderText = (card.innerText || '').replace(/\s+/g, ' ').trim();
      const ariaLabel = card.getAttribute('aria-label') || '';
      results.push({
        photoId,
        sourceImageUrl: source,
        photoIndex: Number.isFinite(Number(card.dataset.photoIndex)) ? Number(card.dataset.photoIndex) : null,
        discoverySource: 'dom',
        looksLikeVideo: /\b\d{1,2}:\d{2}\b/.test(holderText) || /video/i.test(ariaLabel)
          || Boolean(card.querySelector('video, [aria-label*="video" i]')),
      });
      if (results.length >= photoLimit) break;
    }
    return results;
  }, limit);
}

async function scrollGooglePhotoGallery(page) {
  return page.evaluate(() => {
    const cards = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')];
    const anchor = cards.find((card) => {
      const box = card.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    let scroller = anchor?.parentElement;
    while (scroller && scroller !== document.body) {
      const box = scroller.getBoundingClientRect();
      if (scroller.scrollHeight > scroller.clientHeight + 20 && box.width > 0 && box.width < 700) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) return { atBottom: false };
    scroller.scrollBy(0, Math.max(Math.floor(scroller.clientHeight * 0.85), 650));
    return { atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5 };
  });
}

async function collectGooglePhotoDates(page, canonicalUrl, orderedPhotoIds) {
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await acceptConsentIfShown(page);
  if (!await openGooglePhotoGallery(page)) return new Map();
  await clickGooglePhotoTab(page, photoTabs.includes('All') ? 'All' : photoTabs[0]);
  const first = page.locator('a.MIgS0d[data-photo-index]:visible').first();
  if (!await first.isVisible().catch(() => false)) return new Map();
  await first.click();

  const dates = new Map();
  let previousFingerprint = null;
  let repeated = 0;
  for (let index = 0; index < orderedPhotoIds.length; index += 1) {
    await page.waitForTimeout(500);
    const snapshot = await page.evaluate(() => {
      const decodedUrl = decodeURIComponent(location.href);
      const urlPhotoId = decodedUrl.match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=!/?]+)/)?.[1] || null;
      const visibleImages = [...document.querySelectorAll('[style*="googleusercontent"]')]
        .map((element) => {
          const box = element.getBoundingClientRect();
          const source = element.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || '';
          return { source, area: Math.max(0, box.width) * Math.max(0, box.height) };
        })
        .filter(({ source, area }) => area > 40_000 && /googleusercontent\.com/.test(source))
        .sort((left, right) => right.area - left.area);
      const backgroundPhotoId = visibleImages[0]?.source
        .match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=]+)/)?.[1] || null;
      const photoId = urlPhotoId || backgroundPhotoId;
      const lines = document.body.innerText.split(/\n+/).map((line) => line.replace(/\s+/g, ' ').trim());
      const labels = [...document.querySelectorAll('[aria-label]')]
        .map((element) => (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim());
      const dateText = lines.find((line) => /^Photo\s*[-–—]\s*.+/i.test(line))
        || lines.find((line) => /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2}$/i.test(line))
        || labels.find((line) => /^Photo\s*[-–—]\s*.+/i.test(line))
        || null;
      return {
        photoId,
        dateText,
        fingerprint: photoId || visibleImages[0]?.source || location.href,
      };
    });
    const resolvedPhotoId = snapshot.photoId || orderedPhotoIds[index];
    if (!resolvedPhotoId) break;
    if (snapshot.fingerprint === previousFingerprint) repeated += 1;
    else repeated = 0;
    if (repeated >= 2) break;
    previousFingerprint = snapshot.fingerprint;
    if (snapshot.dateText) dates.set(resolvedPhotoId, parseGoogleUploadDate(snapshot.dateText));

    const next = page.getByRole('button', { name: /next/i }).filter({ visible: true }).first();
    if (await next.isVisible().catch(() => false)) await next.click().catch(() => {});
    else await page.keyboard.press('ArrowRight').catch(() => {});
    await page.waitForTimeout(700);
  }
  await page.keyboard.press('Escape').catch(() => {});
  return dates;
}

function parseGoogleUploadDate(value) {
  const text = value.replace(/^Photo\s*[-–—]\s*/i, '').trim();
  const months = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
    may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
    sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };
  const match = text.match(/^([A-Za-z]+)\.?\s+(?:(\d{1,2}),?\s+)?((?:19|20)\d{2})$/);
  if (!match) return { text, year: null, month: null, day: null };
  return {
    text,
    year: Number(match[3]),
    month: months[match[1].toLowerCase()] ?? null,
    day: match[2] ? Number(match[2]) : null,
  };
}

function photoDateRank(uploadDate) {
  if (!uploadDate?.year) return Number.NEGATIVE_INFINITY;
  return Date.UTC(uploadDate.year, (uploadDate.month ?? 1) - 1, uploadDate.day ?? 1);
}

async function probeFullSizePhotos(page, photos) {
  const inputs = photos.map(({ sourceImageUrl }) => ({
    url: `${sourceImageUrl.replace(/=[^/]*$/, '')}=s0`,
  }));
  return page.evaluate(async (entries) => {
    const results = new Array(entries.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < entries.length) {
        const index = cursor;
        cursor += 1;
        const { url } = entries[index];
        results[index] = await new Promise((resolve) => {
          const image = new Image();
          const timeout = setTimeout(() => resolve({ loaded: false, url, error: 'Image probe timed out' }), 30_000);
          image.onload = () => {
            clearTimeout(timeout);
            const result = { loaded: true, url, width: image.naturalWidth, height: image.naturalHeight };
            image.src = '';
            resolve(result);
          };
          image.onerror = () => {
            clearTimeout(timeout);
            resolve({ loaded: false, url, error: 'Image failed to load' });
          };
          image.src = url;
        });
      }
    };
    // Full-size Google images can be large. Probe them one at a time to keep
    // Chrome's peak memory stable while preserving URL and dimension data.
    await Promise.all(Array.from({ length: Math.min(1, entries.length) }, worker));
    return results;
  }, inputs);
}

function photoIdentity(source) {
  return source.match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=]+)/)?.[1]
    || source.replace(/=[^/]*$/, '');
}

function extractGooglePhotoUrls(body) {
  const normalized = body
    .replaceAll('\\u003d', '=')
    .replaceAll('\\u0026', '&')
    .replaceAll('\\/', '/');
  const matches = normalized.match(/(?:https?:)?\/\/lh\d+\.googleusercontent\.com\/(?:p|gps-cs-s)\/[A-Za-z0-9_-]+(?:=[A-Za-z0-9_-]+)?/g) || [];
  const photos = new Map();
  for (const match of matches) {
    const source = match.startsWith('//') ? `https:${match}` : match;
    photos.set(photoIdentity(source), source);
  }
  return [...photos.values()];
}

function coordinatesFromUrl(url) {
  const match = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
    || url.match(/!3d(-?\d+(?:\.\d+)?)[^!]*!4d(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  return { latitude: Number(match[1]), longitude: Number(match[2]) };
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function booleanValue(value, fallback) {
  if (value == null || value === '') return fallback;
  return value.toLowerCase() === 'true';
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;

  const totalSeconds = milliseconds / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

function derivePeakHours(popularTimes) {
  if (!popularTimes?.length) return [];

  const percentages = popularTimes.map((label) => ({
    label,
    percentage: Number(label.match(/(\d{1,3})%/)?.[1] ?? -1),
  }));
  const highestPercentage = Math.max(...percentages.map(({ percentage }) => percentage));
  if (highestPercentage >= 0) {
    return percentages
      .filter(({ percentage }) => percentage === highestPercentage)
      .map(({ label }) => label);
  }

  return popularTimes.filter((label) => /as busy as it gets|very busy|peak/i.test(label));
}

function toCsv(items) {
  const columns = [
    'name', 'category', 'rating', 'reviewCount', 'priceLevel', 'address', 'phone',
    'website', 'plusCode', 'menu', 'photos', 'photoScrape', 'openingHours', 'peakHours', 'about', 'contact',
    'latitude', 'longitude', 'googleMapsUrl', 'query', 'area',
    'scrapedAt',
  ];
  const escape = (value) => {
    const string = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${string.replaceAll('"', '""')}"`;
  };
  return `${columns.join(',')}\n${items.map((item) => columns.map((column) => escape(item[column])).join(',')).join('\n')}\n`;
}
