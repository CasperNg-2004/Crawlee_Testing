import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  PlaywrightCrawler,
  Dataset,
  KeyValueStore,
  NonRetryableError,
  RequestQueue,
  createPlaywrightRouter,
  log,
} from 'crawlee';
import { classifyMalaysiaBrand, loadMalaysiaBrandCatalog } from './brand-classifier.js';
import {
  extractGooglePlaceMetadata,
  extractGooglePlaceMetadataFromText,
  googlePlaceIdentity,
  normalizeGooglePlaceInput,
  selectBestGooglePlaceUrl,
} from './google-place.js';
import { cleanMenuDescription } from './menu-utils.js';
import {
  normalizePhotoTabName,
  parseGoogleUploadDate,
  photoDateRank,
} from './photo-utils.js';
import { flattenPhotoList, photoListToCsv } from './photo-export.js';
import { extractGoogleReviews, normalizeReviewSort } from './review-scraper.js';
import { classifyGoogleSafetyState, isSuspiciousEmptyMenu } from './safety.js';

let runSummaryPrinted = false;
process.on('uncaughtException', (error) => {
  if (!runSummaryPrinted) {
    runSummaryPrinted = true;
    console.error(error);
    console.log(`RUN_SUMMARY ${JSON.stringify({
      status: 'failed',
      exitCode: 1,
      succeeded: null,
      failed: null,
      safetyStop: null,
      error: error?.message || String(error),
      outputDir: process.env.OUTPUT_DIR?.trim() || 'output',
    })}`);
  }
  process.exit(1);
});

// PowerShell truncates Format-Table output to the terminal width on Windows.
// Crawlee expects the complete `WorkingSetSize` process-list header.
if (process.platform === 'win32') process.env.COLUMNS = '200';

const query = process.env.QUERY?.trim() || 'restaurant';
const onePlaceArgumentIndex = process.argv.indexOf('--one-place');
const onePlaceArgument = onePlaceArgumentIndex >= 0
  ? process.argv[onePlaceArgumentIndex + 1]?.trim()
  : null;
const onePlaceInput = onePlaceArgument || process.env.ONE_PLACE?.trim() || null;
const onePlaceMode = onePlaceArgumentIndex >= 0 || Boolean(process.env.ONE_PLACE?.trim());
if (onePlaceMode && !onePlaceInput) {
  throw new Error('One-place mode requires a ChIJ place ID or Google Maps URL after --one-place or in ONE_PLACE.');
}
const queries = (process.env.QUERIES?.trim() || query)
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const area = process.env.AREA?.trim() || 'Kuala Lumpur, Malaysia';
const maxPlaces = onePlaceMode ? 1 : positiveInteger(process.env.MAX_PLACES, 1000);
const maxStalledScrolls = positiveInteger(process.env.MAX_STALLED_SCROLLS, 12);
const scrollWaitMs = positiveInteger(process.env.SCROLL_WAIT_MS, 2_000);
const headless = process.env.HEADLESS?.toLowerCase() !== 'false';
const outputDir = process.env.OUTPUT_DIR?.trim() || 'output';
const chromeProfileDir = resolve(process.env.CHROME_PROFILE_DIR?.trim() || '.chrome-profile');
const brandCatalogPath = resolve(
  process.env.CHAIN_CLASSIFICATION_CATALOG?.trim() || 'config/malaysia-chain-counts.json',
);
const brandCatalog = await loadMalaysiaBrandCatalog(brandCatalogPath);
const areas = (process.env.AREAS?.trim() || area)
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const searchTargets = queries.flatMap((searchQuery) => areas.map((searchArea) => ({
  key: `${searchQuery}\u0000${searchArea}`,
  query: searchQuery,
  area: searchArea,
})));
const maxCandidatesPerArea = positiveInteger(process.env.MAX_CANDIDATES_PER_AREA, 150);
const scrapePhotos = booleanValue(process.env.SCRAPE_PHOTOS, false);
const photoTabs = (process.env.PHOTO_TABS?.trim() || 'Menu|By owner|All|Food & drink|Vibe')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const photoMaxPerPlace = positiveInteger(process.env.PHOTO_MAX_PER_PLACE, 30);
const photoScanLimit = positiveInteger(process.env.PHOTO_SCAN_LIMIT, 30);
const photoTabLimits = new Map([
  ['menu', positiveInteger(process.env.PHOTO_LIMIT_MENU, 8)],
  ['by owner', positiveInteger(process.env.PHOTO_LIMIT_BY_OWNER, 4)],
  ['all', positiveInteger(process.env.PHOTO_LIMIT_ALL, 30)],
  ['food & drink', positiveInteger(process.env.PHOTO_LIMIT_FOOD_DRINK, 8)],
  ['vibe', positiveInteger(process.env.PHOTO_LIMIT_VIBE, 3)],
]);
const photoScrollRounds = positiveInteger(process.env.PHOTO_SCROLL_ROUNDS, 120);
const photoCaptureUploadDate = booleanValue(process.env.PHOTO_CAPTURE_UPLOAD_DATE, true);
const photoDateBatchSize = positiveInteger(process.env.PHOTO_DATE_BATCH_SIZE, 10);
const photoDateConcurrency = positiveInteger(process.env.PHOTO_DATE_CONCURRENCY, 1);
const photoDateWaitMs = positiveInteger(process.env.PHOTO_DATE_WAIT_MS, 300);
const photoProbeConcurrency = positiveInteger(process.env.PHOTO_PROBE_CONCURRENCY, 2);
const photoDebug = booleanValue(process.env.PHOTO_DEBUG, false);
const scrapeReviews = booleanValue(process.env.SCRAPE_REVIEWS, true);
const reviewMaxPerPlace = positiveInteger(process.env.REVIEW_MAX_PER_PLACE, 50);
const reviewScrollRounds = positiveInteger(process.env.REVIEW_SCROLL_ROUNDS, 100);
const reviewScrollWaitMs = positiveInteger(process.env.REVIEW_SCROLL_WAIT_MS, 250);
const reviewSort = normalizeReviewSort(process.env.REVIEW_SORT || 'newest');
const menuMaxAttempts = positiveInteger(process.env.MENU_MAX_ATTEMPTS, 2);
const menuScrollMaxRounds = positiveInteger(process.env.MENU_SCROLL_MAX_ROUNDS, 80);
const menuScrollWaitMs = positiveInteger(process.env.MENU_SCROLL_WAIT_MS, 350);
const maxConsecutiveEmptyMenus = positiveInteger(
  process.env.MAX_CONSECUTIVE_EMPTY_MENUS, 3,
);
const requireGoogleSignIn = booleanValue(process.env.REQUIRE_GOOGLE_SIGN_IN, true);
const emptyMenuSafetyStateKey = 'EMPTY_MENU_SAFETY_STATE_V1';
const isResumedStorageRun = process.env.CRAWLEE_PURGE_ON_START === '0';
const configuredPlaceIds = (process.env.PLACE_IDS?.trim() || '')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const configuredPlaceUrls = (process.env.PLACE_URLS?.trim() || '')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const directPlaceInputs = onePlaceMode
  ? [onePlaceInput]
  : [...configuredPlaceIds, ...configuredPlaceUrls];
const directPlaceUrls = [...new Map(directPlaceInputs.map((value) => {
  const url = normalizeGooglePlaceInput(value, query);
  return [googlePlaceIdentity(url), url];
})).values()];
const maxRequestsPerCrawl = positiveInteger(process.env.MAX_REQUESTS_PER_CRAWL, undefined);
const maxRequestRetries = 2;
const browserPageBudget = ((areas.length + maxPlaces) * (maxRequestRetries + 1)) + 100;
const runStartedAt = Date.now();

let queuedPlaceCount = 0;
let successfulPlaceCount = 0;
let failedPlaceCount = 0;
let detailRequestsQueued = false;
let fatalSafetyStop = null;
const areaCandidates = new Map();
const failedRestaurantRecords = [];
const knownDetailRequests = new Map();
const completedPlaceIdentities = new Set();
const pendingEmptyMenuRecords = [];
const knownQueueRequestIds = new Set();

const router = createPlaywrightRouter();

router.addHandler('SEARCH', async ({ page, request, log: requestLog }) => {
  await acceptConsentIfShown(page);
  await enforceGoogleSafety(page, request);

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

  areaCandidates.set(request.userData.searchKey, [...placeUrls]);
  requestLog.info(`Discovery finished for ${request.userData.area}: ${placeUrls.size} candidates stored.`);
  await queueDetailsWhenDiscoveryComplete();
});

router.addHandler('DETAIL', async ({ page, request, pushData, log: requestLog }) => {
  await acceptConsentIfShown(page);
  await enforceGoogleSafety(page, request);
  try {
    await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  } catch (error) {
    await enforceGoogleSafety(page, request);
    throw error;
  }
  await enforceGoogleSafety(page, request);
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

  const canonicalUrl = await resolveGooglePlaceUrl(page, request.url, initialHeading);
  const pageMetadata = await extractGooglePlaceMetadataFromLoadedPage(
    page, request.url, initialHeading,
  );
  const details = await page.evaluate(() => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const main = document.querySelector('div[role="main"]') || document.body;
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

    const pageText = clean(main.innerText) || '';
    const businessStatus = /\bpermanently closed\b/i.test(pageText)
      ? 'permanently_closed'
      : /\btemporarily closed\b/i.test(pageText)
        ? 'temporarily_closed'
        : 'open';

    return {
      name: text('h1'),
      category,
      businessStatus,
      address: stripLabel(itemText('address'), ['Address']),
      phone: stripLabel(itemText('phone'), ['Phone']),
      website: websiteElement?.href || null,
      openingHours: hours,
      popularTimeLabels,
    };
  });
  Object.assign(details, headerSummary);

  const popularTimes = await extractPopularTimes(page);
  const peakHours = popularTimes
    ? derivePeakHoursFromBreakdown(popularTimes)
    : derivePeakHours(details.popularTimeLabels);
  delete details.popularTimeLabels;
  const menuResult = await extractGoogleMenu(page);
  const about = await extractAbout(page);
  let reviewTaskPromise = null;
  const startReviewTask = () => {
    if (!reviewTaskPromise) {
      reviewTaskPromise = extractGoogleReviews(page, {
        name: details.name,
        googleMapsUrl: canonicalUrl,
        reviewCount: details.reviewCount,
      }, {
        maxReviews: reviewMaxPerPlace,
        maxScrollRounds: reviewScrollRounds,
        scrollWaitMs: reviewScrollWaitMs,
        sort: reviewSort,
        safetyCheck: async () => enforceGoogleSafety(page, request),
      }).then(
        (result) => ({ result, error: null }),
        (error) => ({ result: null, error }),
      );
    }
    return reviewTaskPromise;
  };
  const photoResult = scrapePhotos
    ? await extractGooglePhotos(
      page,
      canonicalUrl,
      requestLog,
      scrapeReviews ? startReviewTask : null,
    )
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
  let reviewResult = { reviews: null, reviewScrape: null };
  if (scrapeReviews) {
    const reviewTask = await startReviewTask();
    if (reviewTask.error) throw reviewTask.error;
    reviewResult = reviewTask.result;
  }
  if (reviewResult.reviewScrape) {
    reviewResult.reviewScrape.requestAttempts = request.retryCount + 1;
  }

  const { phone, website } = details;
  const brandClassification = classifyMalaysiaBrand(details, brandCatalog);
  const canonicalMetadata = extractGooglePlaceMetadata(canonicalUrl);
  const requestedMetadata = extractGooglePlaceMetadata(request.url);
  const placeMetadata = {
    placeId: canonicalMetadata.placeId ?? pageMetadata.placeId ?? requestedMetadata.placeId,
    featureId: canonicalMetadata.featureId ?? pageMetadata.featureId ?? requestedMetadata.featureId,
    latitude: canonicalMetadata.latitude ?? pageMetadata.latitude ?? requestedMetadata.latitude,
    longitude: canonicalMetadata.longitude ?? pageMetadata.longitude ?? requestedMetadata.longitude,
  };
  const record = {
    name: details.name,
    placeId: placeMetadata.placeId,
    featureId: placeMetadata.featureId,
    latitude: placeMetadata.latitude,
    longitude: placeMetadata.longitude,
    rating: details.rating,
    area: request.userData.area,
    category: details.category,
    businessStatus: details.businessStatus,
    brandSize: brandClassification.brandSize,
    numberOfOutlets: brandClassification.numberOfOutlets,
    address: details.address,
    contact: {
      phone,
      website,
    },
    reviewCount: details.reviewCount,
    priceLevel: details.priceLevel,
    openingHours: details.openingHours,
    menu: menuResult.menu,
    menuScrape: menuResult.menuScrape,
    popularTimes,
    peakHours,
    query: request.userData.query,
    about,
    photos: photoResult.photos,
    photoScrape: photoResult.photoScrape,
    reviews: reviewResult.reviews,
    reviewScrape: reviewResult.reviewScrape,
    googleMapsUrl: canonicalUrl,
    scrapedAt: new Date().toISOString(),
  };

  if (isSuspiciousEmptyMenu(record.menuScrape)) {
    pendingEmptyMenuRecords.push({
      record,
      requestUrl: request.url,
      userData: { ...request.userData },
      attempts: request.retryCount + 1,
    });
    await persistPendingEmptyMenuRecords();
    requestLog.warning(
      `Menu tab loaded with 0 typed items (${pendingEmptyMenuRecords.length}/${maxConsecutiveEmptyMenus} consecutive).`,
    );
    if (pendingEmptyMenuRecords.length >= maxConsecutiveEmptyMenus) {
      await stopForConsecutiveEmptyMenus(request);
    }
    return;
  }

  await flushPendingEmptyMenuRecords(requestLog);
  clearPreviousFailure(record);
  await pushData(record);
  markRecordCompleted(record, request.url);
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
      phone: record.contact.phone,
      website: record.contact.website,
      menuItemCount: countMenuItems(record.menu),
      menuScrapeStatus: record.menuScrape.status,
      photoCount: record.photos?.length ?? 0,
      photoScrapeStatus: record.photoScrape?.status ?? null,
      scrapedReviewCount: record.reviews?.length ?? 0,
      reviewScrapeStatus: record.reviewScrape?.status ?? null,
      openingHours: record.openingHours,
      peakHours: record.peakHours,
      popularTimesSummary: record.popularTimes ? {
        overallPeak: record.popularTimes.overallPeak,
        overallQuietest: record.popularTimes.overallQuietest,
        daysWithData: record.popularTimes.days.filter((day) => day.hours.length > 0).length,
      } : null,
      about: record.about,
      url: canonicalUrl,
    },
  );
});

const requestQueue = await RequestQueue.open();
const crawler = new PlaywrightCrawler({
  requestQueue,
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
  maxConcurrency: (directPlaceUrls.length || scrapePhotos || scrapeReviews) ? 1 : 2,
  maxRequestsPerCrawl,
  maxRequestRetries,
  requestHandlerTimeoutSecs: scrapePhotos || scrapeReviews ? 900 : 180,
  navigationTimeoutSecs: 45,
  preNavigationHooks: [async ({ page, request }) => {
    request.userData.startedAt = Date.now();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-MY,en;q=0.9' });
  }],
  failedRequestHandler: async ({ request, log: requestLog }, error) => {
    const elapsedMs = Date.now() - (request.userData.startedAt ?? Date.now());
    if (request.label === 'DETAIL') {
      if (!fatalSafetyStop) await flushPendingEmptyMenuRecords(requestLog);
      if (!request.userData.failureRecorded) {
        recordFailedDetailRequest(request, error?.message || 'Request failed after all retries', {
          stage: fatalSafetyStop ? 'safety-stop' : 'restaurant-page',
          safetyStop: fatalSafetyStop,
        });
      }
    } else if (request.label === 'SEARCH') {
      areaCandidates.set(request.userData.searchKey, []);
      if (!fatalSafetyStop) await queueDetailsWhenDiscoveryComplete();
    }
    requestLog.error(`Failed after retries in ${formatDuration(elapsedMs)}: ${request.url}`, {
      label: request.label,
      searchArea: request.userData.area,
      retryCount: request.retryCount,
    });
  },
});

const searchRequests = searchTargets.map(({ key, query: searchQuery, area: searchArea }) => ({
  url: buildSearchUrl(searchQuery, searchArea),
  label: 'SEARCH',
  uniqueKey: `search:${searchQuery}:${searchArea}`,
  userData: { searchKey: key, query: searchQuery, area: searchArea },
}));

const initialRequests = directPlaceUrls.length
  ? directPlaceUrls.slice(0, maxPlaces).map((url) => ({
    url,
    label: 'DETAIL',
    uniqueKey: googlePlaceIdentity(url),
    userData: { area: 'Direct input', query },
  }))
  : searchRequests;
for (const request of initialRequests.filter(({ label }) => label === 'DETAIL')) {
  knownDetailRequests.set(placeIdentity(request.url), request);
}
if (directPlaceUrls.length) {
  detailRequestsQueued = true;
  queuedPlaceCount = initialRequests.length;
  log.info(`Scraping ${queuedPlaceCount} direct Google Maps place input(s)${onePlaceMode ? ' in one-place mode' : ''}.`);
} else {
  log.info(
    `Searching for ${queries.map((value) => `"${value}"`).join(', ')} across `
    + `${areas.length} area(s) (${searchTargets.length} searches), up to ${maxPlaces} unique places.`,
  );
}
log.info(`Using the dedicated Chrome profile at ${chromeProfileDir}. Run \`npm run login\` if Maps requests sign-in.`);
log.info(`Loaded ${brandCatalog.length} Malaysia brand-count catalog entr${brandCatalog.length === 1 ? 'y' : 'ies'}.`);
log.info(`Keeping one Chrome session for up to ${browserPageBudget} page uses to avoid profile-lock relaunches.`);
if (maxRequestsPerCrawl) {
  log.info(`This process will stop cleanly after at most ${maxRequestsPerCrawl} requests for controlled batching.`);
}
await restoreRunProgress();
await restorePendingEmptyMenuRecords();
// Seed the complete input set directly into storage before starting the crawler.
// Passing initialRequests to crawler.run() lets maxRequestsPerCrawl cap both
// processing and initial queue insertion, which can silently discard direct
// place IDs beyond the first safe-mode batch.
await addRequestsToQueue(initialRequests);
await rememberPendingQueueRequestIds();
await crawler.run();
await releasePendingQueueLocks();
const requestQueueInfo = await requestQueue.getInfo();
const pendingRequestCount = requestQueueInfo?.pendingRequestCount ?? 0;
if (!fatalSafetyStop) {
  if (pendingRequestCount > 0 && pendingEmptyMenuRecords.length > 0) {
    await persistPendingEmptyMenuRecords();
    log.info(
      `Preserved ${pendingEmptyMenuRecords.length} pending empty-menu result(s) across the controlled restart.`,
    );
  } else {
    await flushPendingEmptyMenuRecords();
  }
}
const remainingSafetyFailures = appendRemainingSafetyFailures();

const dataset = await Dataset.getData({ limit: maxPlaces });
await mkdir(outputDir, { recursive: true });
let exportedRecords = dataset.items;
if (onePlaceMode) {
  const onePlaceRecord = dataset.items[0] ?? failedRestaurantRecords[0] ?? null;
  exportedRecords = onePlaceRecord ? [onePlaceRecord] : [];
  await writeFileAtomic(`${outputDir}/place.json`, `${JSON.stringify(onePlaceRecord, null, 2)}\n`);
} else {
  await writeFileAtomic(`${outputDir}/restaurants.json`, `${JSON.stringify(dataset.items, null, 2)}\n`);
  await writeFileAtomic(`${outputDir}/restaurants.csv`, toCsv(dataset.items));
}
const photoList = flattenPhotoList(exportedRecords);
await writeFileAtomic(`${outputDir}/photo-list.json`, `${JSON.stringify(photoList, null, 2)}\n`);
await writeFileAtomic(`${outputDir}/photo-list.csv`, photoListToCsv(photoList));
await writeFileAtomic(
  `${outputDir}/failed-restaurants.json`,
  `${JSON.stringify(failedRestaurantRecords, null, 2)}\n`,
);
log.info(
  `Finished in ${formatDuration(Date.now() - runStartedAt)}. `
  + `Scraped ${successfulPlaceCount}/${queuedPlaceCount} places successfully; ${failedPlaceCount} failed. `
  + (onePlaceMode
    ? `Exported the one-place result to ${outputDir}/place.json.`
    : `Exported ${dataset.items.length} records to ${outputDir}/restaurants.json and ${outputDir}/restaurants.csv.`)
  + ` Exported ${photoList.length} photo-tab rows to ${outputDir}/photo-list.json and ${outputDir}/photo-list.csv.`,
);
const exitCode = fatalSafetyStop ? 2 : failedPlaceCount > 0 ? 1 : 0;
const runStatus = fatalSafetyStop ? 'safety_stopped' : failedPlaceCount > 0 ? 'completed_with_failures' : 'success';
runSummaryPrinted = true;
console.log(`RUN_SUMMARY ${JSON.stringify({
  status: runStatus,
  exitCode,
  succeeded: dataset.items.length,
  failed: failedRestaurantRecords.length,
  remainingMarkedFailed: remainingSafetyFailures,
  safetyStop: fatalSafetyStop,
  outputDir,
})}`);

// Crawlee leaves its Chrome version-probe child alive with persistent contexts on Windows.
// All crawler teardown and output writes are complete here, so exit cleanly and release the profile.
process.exit(exitCode);

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

async function detectGoogleSafetyIssue(page) {
  const snapshot = await page.evaluate(() => {
    const visible = (element) => {
      const box = element?.getBoundingClientRect();
      return Boolean(box && box.width > 0 && box.height > 0);
    };
    const controls = [...document.querySelectorAll('a, button')].filter(visible);
    const signInVisible = controls.some((element) => {
      const text = (element.textContent || '').replace(/\s+/g, ' ').trim();
      const label = (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      const href = element.getAttribute('href') || '';
      return /^(sign in|log in)$/i.test(text) || /sign in/i.test(label)
        || /accounts\.google\.[^/]+\/.*(?:signin|login)/i.test(href);
    });
    const accountVisible = [...document.querySelectorAll('[aria-label], img[alt]')]
      .filter(visible)
      .some((element) => /google account|account menu|profile picture/i.test(
        `${element.getAttribute('aria-label') || ''} ${element.getAttribute('alt') || ''}`,
      ));
    const hasCaptcha = [...document.querySelectorAll('iframe, form, [id], [class]')]
      .some((element) => /recaptcha|captcha/i.test(
        `${element.getAttribute('src') || ''} ${element.id || ''} ${element.className || ''}`,
      ));
    return {
      bodyText: document.body?.innerText || '',
      signInVisible,
      accountVisible,
      hasCaptcha,
    };
  }).catch(() => null);
  return classifyGoogleSafetyState(snapshot, { requireSignIn: requireGoogleSignIn });
}

async function enforceGoogleSafety(page, request) {
  const issue = await detectGoogleSafetyIssue(page);
  if (!issue) return;
  await activateSafetyStop(issue, request);
}

async function activateSafetyStop(issue, request) {
  if (!fatalSafetyStop) {
    fatalSafetyStop = {
      code: issue.code,
      message: issue.message,
      url: request.url,
      detectedAt: new Date().toISOString(),
    };
    await failPendingEmptyMenuRecords(
      `Safety stop ${issue.code}: ${issue.message}`,
      'safety-stop-buffered-menu',
    );
    log.error(`Safety stop activated: ${issue.code} — ${issue.message}`);
  }

  request.noRetry = true;
  request.userData.failureRecorded = completedPlaceIdentities.has(placeIdentity(request.url));
  crawler.stop(`Safety stop: ${issue.code}`);
  throw new NonRetryableError(`SAFETY_STOP[${issue.code}]: ${issue.message}`);
}

async function stopForConsecutiveEmptyMenus(request) {
  await activateSafetyStop({
    code: 'consecutive_empty_menus',
    message: `${maxConsecutiveEmptyMenus} consecutive places had a Menu tab but 0 typed items.`,
  }, request);
}

async function flushPendingEmptyMenuRecords(logger = log) {
  if (!pendingEmptyMenuRecords.length) {
    await clearPendingEmptyMenuState();
    return;
  }
  const pending = pendingEmptyMenuRecords.splice(0);
  for (const entry of pending) {
    clearPreviousFailure(entry.record);
    await Dataset.pushData(entry.record);
    markRecordCompleted(entry.record, entry.requestUrl);
    successfulPlaceCount += 1;
  }
  await clearPendingEmptyMenuState();
  logger.info(`Confirmed and saved ${pending.length} place(s) with an empty typed menu.`);
}

async function failPendingEmptyMenuRecords(error, stage) {
  const pending = pendingEmptyMenuRecords.splice(0);
  for (const entry of pending) {
    const identity = placeIdentity(entry.requestUrl);
    if (completedPlaceIdentities.has(identity)) continue;
    failedRestaurantRecords.push({
      ...entry.record,
      menu: null,
      menuScrape: {
        ...entry.record.menuScrape,
        status: 'failed',
        error,
      },
      status: 'failed',
      stage,
      attempts: entry.attempts,
      error,
      safetyStop: fatalSafetyStop,
      failedAt: new Date().toISOString(),
    });
    completedPlaceIdentities.add(identity);
    failedPlaceCount += 1;
  }
  await clearPendingEmptyMenuState();
}

async function restorePendingEmptyMenuRecords() {
  if (!isResumedStorageRun) return;
  const state = await KeyValueStore.getValue(emptyMenuSafetyStateKey);
  if (!Array.isArray(state?.records) || state.records.length === 0) return;
  pendingEmptyMenuRecords.push(...state.records);
  log.info(
    `Restored ${state.records.length} pending empty-menu result(s) from the previous safe-run process.`,
  );
}

async function restoreRunProgress() {
  if (!isResumedStorageRun) return;

  const existingDataset = await Dataset.getData({ limit: maxPlaces });
  for (const record of existingDataset.items) {
    markRecordCompleted(record);
  }
  successfulPlaceCount = existingDataset.items.length;

  try {
    const priorFailures = JSON.parse(
      await readFile(`${outputDir}/failed-restaurants.json`, 'utf8'),
    );
    if (Array.isArray(priorFailures)) {
      for (const record of priorFailures) {
        const identities = storedRecordIdentities(record);
        if (identities.some((identity) => completedPlaceIdentities.has(identity))) continue;
        failedRestaurantRecords.push(record);
        markRecordCompleted(record);
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  failedPlaceCount = failedRestaurantRecords.length;

  if (successfulPlaceCount || failedPlaceCount) {
    log.info(
      `Restored ${successfulPlaceCount} successful and ${failedPlaceCount} failed place result(s).`,
    );
  }
}

async function persistPendingEmptyMenuRecords() {
  if (pendingEmptyMenuRecords.length === 0) {
    await clearPendingEmptyMenuState();
    return;
  }
  await KeyValueStore.setValue(emptyMenuSafetyStateKey, {
    records: pendingEmptyMenuRecords,
    updatedAt: new Date().toISOString(),
  });
}

async function clearPendingEmptyMenuState() {
  await KeyValueStore.setValue(emptyMenuSafetyStateKey, null);
}

function clearPreviousFailure(record) {
  const identities = new Set(storedRecordIdentities(record));
  if (!identities.size) return;
  for (let index = failedRestaurantRecords.length - 1; index >= 0; index -= 1) {
    const matches = storedRecordIdentities(failedRestaurantRecords[index])
      .some((identity) => identities.has(identity));
    if (!matches) continue;
    failedRestaurantRecords.splice(index, 1);
  }
  failedPlaceCount = failedRestaurantRecords.length;
  for (const identity of identities) completedPlaceIdentities.delete(identity);
}

function storedRecordIdentities(record) {
  return [...new Set([
    record?.placeId ? `place-id:${record.placeId}` : null,
    record?.featureId ? `feature-id:${record.featureId}` : null,
    record?.googleMapsUrl ? placeIdentity(record.googleMapsUrl) : null,
  ].filter(Boolean))];
}

function markRecordCompleted(record, requestUrl = null) {
  if (requestUrl) completedPlaceIdentities.add(placeIdentity(requestUrl));
  for (const identity of storedRecordIdentities(record)) completedPlaceIdentities.add(identity);
}

function recordFailedDetailRequest(request, error, { stage, safetyStop = null, attempts } = {}) {
  const identity = placeIdentity(request.url);
  if (completedPlaceIdentities.has(identity)) return;
  failedRestaurantRecords.push({
    ...extractGooglePlaceMetadata(request.url),
    googleMapsUrl: request.url,
    query: request.userData.query ?? query,
    area: request.userData.area ?? null,
    businessStatus: null,
    menu: null,
    menuScrape: menuScrapeResult(
      'failed', null, 0, 0, attempts ?? request.retryCount + 1,
      'Place page failed before typed-menu collection completed.',
    ),
    status: 'failed',
    stage: stage || 'restaurant-page',
    attempts: attempts ?? request.retryCount + 1,
    error,
    safetyStop,
    failedAt: new Date().toISOString(),
  });
  completedPlaceIdentities.add(identity);
  failedPlaceCount += 1;
}

function appendRemainingSafetyFailures() {
  if (!fatalSafetyStop) return 0;
  let added = 0;
  for (const request of knownDetailRequests.values()) {
    const identity = placeIdentity(request.url);
    if (completedPlaceIdentities.has(identity)) continue;
    recordFailedDetailRequest(
      { ...request, retryCount: -1, userData: request.userData || {} },
      `Not attempted because the run stopped: ${fatalSafetyStop.message}`,
      { stage: 'safety-stop-remaining', safetyStop: fatalSafetyStop, attempts: 0 },
    );
    added += 1;
  }
  return added;
}

function cleanPlaceUrl(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function resolveGooglePlaceUrl(page, requestedUrl, placeName) {
  const candidates = await page.evaluate(() => {
    const results = new Set([location.href]);
    const add = (value) => {
      if (!value) return;
      try {
        const url = new URL(value, location.href);
        if (/(^|\.)google\.[a-z.]+$/i.test(url.hostname) && /^\/maps(?:\/|$)/i.test(url.pathname)) {
          results.add(url.toString());
        }
      } catch {
        // Ignore malformed page attributes; only valid Maps URLs are candidates.
      }
    };

    add(document.querySelector('link[rel="canonical"]')?.getAttribute('href'));
    add(document.querySelector('meta[property="og:url"]')?.getAttribute('content'));
    add(document.querySelector('meta[itemprop="url"]')?.getAttribute('content'));
    for (const element of document.querySelectorAll('a[href], [data-href], [data-url]')) {
      add(element.getAttribute('href'));
      add(element.getAttribute('data-href'));
      add(element.getAttribute('data-url'));
      if (results.size >= 500) break;
    }
    return [...results];
  }).catch(() => [page.url()]);

  return selectBestGooglePlaceUrl(candidates, requestedUrl, placeName);
}

async function extractGooglePlaceMetadataFromLoadedPage(page, requestedUrl, placeName) {
  const requestedMetadata = extractGooglePlaceMetadata(requestedUrl);
  const markers = [requestedMetadata.placeId, placeName].filter(Boolean);
  const snippets = await page.evaluate((pageMarkers) => {
    const sources = [document.documentElement.innerHTML];
    for (const key of ['APP_INITIALIZATION_STATE', 'APP_OPTIONS']) {
      try {
        const serialized = JSON.stringify(globalThis[key]);
        if (serialized) sources.push(serialized);
      } catch {
        // A missing or non-serializable Google page-state object is optional.
      }
    }

    const results = [];
    for (const source of sources) {
      const lowerSource = source.toLowerCase();
      for (const marker of pageMarkers) {
        const lowerMarker = marker.toLowerCase();
        let cursor = 0;
        let matches = 0;
        while (matches < 4 && results.length < 12) {
          const index = lowerSource.indexOf(lowerMarker, cursor);
          if (index < 0) break;
          const start = Math.max(0, index - 200_000);
          const end = Math.min(source.length, index + marker.length + 200_000);
          results.push(source.slice(start, end));
          cursor = index + marker.length;
          matches += 1;
        }
      }
    }
    return results;
  }, markers).catch(() => []);

  const result = { ...requestedMetadata };
  for (const snippet of snippets) {
    const metadata = extractGooglePlaceMetadataFromText(
      snippet, requestedMetadata.placeId || placeName,
    );
    if (!result.placeId && metadata.placeId) result.placeId = metadata.placeId;
    if (!result.featureId && metadata.featureId) result.featureId = metadata.featureId;
    if (result.latitude == null && metadata.latitude != null) result.latitude = metadata.latitude;
    if (result.longitude == null && metadata.longitude != null) result.longitude = metadata.longitude;
    if (result.featureId && result.latitude != null && result.longitude != null) break;
  }
  return result;
}

function buildSearchUrl(searchQuery, searchArea) {
  return `https://www.google.com/maps/search/${encodeURIComponent(`${searchQuery} in ${searchArea}`)}?hl=en`;
}

async function queueDetailsWhenDiscoveryComplete() {
  if (detailRequestsQueued || areaCandidates.size < searchTargets.length) return;
  detailRequestsQueued = true;

  const detailRequests = selectFairCandidates(areaCandidates, searchTargets, maxPlaces);
  for (const request of detailRequests) {
    knownDetailRequests.set(placeIdentity(request.url), request);
  }
  queuedPlaceCount = detailRequests.length;
  logDiscoverySummary(areaCandidates, searchTargets, detailRequests);
  log.info(`Fair round-robin selection queued ${queuedPlaceCount} unique places for detail scraping.`);

  if (detailRequests.length) {
    // Add directly to the underlying queue instead of the crawler-context
    // addRequests helper. The helper obeys maxRequestsPerCrawl and previously
    // discarded every detail request beyond the first safe batch. Direct queue
    // insertion stores all selected places while the crawler still stops at
    // the process-level request limit.
    await addRequestsToQueue(detailRequests);
  }
}

async function addRequestsToQueue(requests) {
  const result = await requestQueue.addRequests(requests);
  for (const item of result.processedRequests || []) {
    if (item.requestId) knownQueueRequestIds.add(item.requestId);
  }
  return result;
}

async function rememberPendingQueueRequestIds() {
  if (!maxRequestsPerCrawl) return;
  const head = await requestQueue.client.listHead({
    limit: Math.max(maxPlaces + searchTargets.length + 100, 1_000),
  });
  for (const item of head.items || []) knownQueueRequestIds.add(item.id);
}

async function releasePendingQueueLocks() {
  if (!maxRequestsPerCrawl || knownQueueRequestIds.size === 0) return;
  let released = 0;
  for (const requestId of knownQueueRequestIds) {
    const storedRequest = await requestQueue.client.getRequest(requestId).catch(() => null);
    if (!storedRequest || storedRequest.handledAt) continue;
    await requestQueue.client.deleteRequestLock(requestId).catch(() => {});
    released += 1;
  }
  if (released > 0) {
    log.info(`Released ${released} pending queue lock(s) for the next safe-run process.`);
  }
}

function selectFairCandidates(candidatesByTarget, targets, limit) {
  const cursors = new Map(targets.map(({ key }) => [key, 0]));
  const seenPlaces = new Set();
  const selected = [];

  while (selected.length < limit) {
    let selectedThisRound = 0;

    for (const target of targets) {
      if (selected.length >= limit) break;
      const candidates = candidatesByTarget.get(target.key) || [];
      let cursor = cursors.get(target.key) || 0;

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
            searchUrl: buildSearchUrl(target.query, target.area),
            query: target.query,
            area: target.area,
          },
        });
        selectedThisRound += 1;
        break;
      }

      cursors.set(target.key, cursor);
    }

    if (selectedThisRound === 0) break;
  }

  return selected;
}

function placeIdentity(url) {
  return googlePlaceIdentity(url);
}

function logDiscoverySummary(candidatesByTarget, targets, selectedRequests) {
  const selectedCounts = new Map(targets.map(({ key }) => [key, 0]));
  for (const request of selectedRequests) {
    const key = `${request.userData.query}\u0000${request.userData.area}`;
    selectedCounts.set(key, (selectedCounts.get(key) || 0) + 1);
  }

  for (const target of targets) {
    log.info(`Search allocation: ${target.query} in ${target.area}`, {
      discovered: candidatesByTarget.get(target.key)?.length || 0,
      selected: selectedCounts.get(target.key) || 0,
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

  if (!menuTab) {
    return {
      menu: null,
      menuScrape: menuScrapeResult('none', false, 0, 0, 1, null),
    };
  }

  let lastError = null;
  let bestMenu = null;
  let bestItemCount = 0;
  let bestCategoryCount = 0;

  for (let attempt = 1; attempt <= menuMaxAttempts; attempt += 1) {
    try {
      await menuTab.click({ timeout: 5_000 });
      await page.waitForTimeout(1_000);
      if (!await waitForGoogleMenuRegion(page)) {
        throw new Error('Menu tab opened but the typed Menu region did not load.');
      }

      const categoryNames = await getMenuCategoryNames(page);
      const categoriesToScrape = categoryNames.length ? categoryNames : [null];
      const rawItems = [];

      for (const categoryName of categoriesToScrape) {
        if (categoryName) {
          const clicked = await clickMenuCategory(page, categoryName);
          if (!clicked) throw new Error(`Menu category did not open: ${categoryName}`);
          await page.waitForTimeout(400);
        }

        rawItems.push(...await collectGoogleMenuCategoryRows(page, categoryName, categoryNames));
      }

      const uniqueItems = normalizeAndMergeMenuItems(rawItems);
      const menu = buildGoogleMenu(uniqueItems);
      const itemCount = uniqueItems.length;
      if (itemCount > bestItemCount) {
        bestMenu = menu;
        bestItemCount = itemCount;
        bestCategoryCount = categoryNames.length;
      }

      if (itemCount > 0) {
        return {
          menu,
          menuScrape: menuScrapeResult(
            'success', true, itemCount, categoryNames.length, attempt, null,
          ),
        };
      }

      if (attempt === menuMaxAttempts) {
        return {
          menu: null,
          menuScrape: menuScrapeResult('none', true, 0, categoryNames.length, attempt, null),
        };
      }
    } catch (error) {
      lastError = error;
      if (attempt < menuMaxAttempts) await page.waitForTimeout(750);
    }
  }

  return {
    menu: bestMenu,
    menuScrape: menuScrapeResult(
      'failed', true, bestItemCount, bestCategoryCount, menuMaxAttempts,
      lastError?.message || 'Unknown typed-menu failure',
    ),
  };
}

function menuScrapeResult(status, tabExists, itemCount, categoryCount, attempts, error) {
  return { status, tabExists, itemCount, categoryCount, attempts, error };
}

function normalizeAndMergeMenuItems(rawItems) {
  const normalizedItems = rawItems.map(normalizeMenuItem).filter(Boolean);
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

  return uniqueItems;
}

function buildGoogleMenu(items) {
  if (!items.length) return null;
  const sections = [];
  for (const item of items) {
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

async function waitForGoogleMenuRegion(page) {
  return page.waitForFunction(() => [...document.querySelectorAll('[role="region"][aria-label]')]
    .some((element) => {
      const box = element.getBoundingClientRect();
      return /^menu$/i.test((element.getAttribute('aria-label') || '').trim())
        && box.width > 0 && box.height > 0;
    }), undefined, { timeout: 8_000 }).then(() => true).catch(() => false);
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
    // Playwright serializes regular-expression text filters into its internal
    // selector syntax. Category names containing repeated apostrophes (for
    // example, an inch measurement such as 9.5'') can be misread as selector
    // flags. Use a plain-text candidate filter and retain the exact aria-label
    // comparison below.
    hasText: categoryName,
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

async function collectGoogleMenuCategoryRows(page, categoryName, categoryNames) {
  const rowsByKey = new Map();
  let stalledRounds = 0;
  await scrollGoogleMenuRegion(page, true);

  for (let round = 0; round < menuScrollMaxRounds; round += 1) {
    const before = rowsByKey.size;
    const visibleRows = await extractVisibleMenuRows(page, categoryName, categoryNames);
    for (const row of visibleRows) {
      const key = `${row.name || ''}\u0000${row.displayedPrice || ''}\u0000${row.description || ''}`;
      if (!rowsByKey.has(key)) rowsByKey.set(key, row);
    }

    stalledRounds = rowsByKey.size === before ? stalledRounds + 1 : 0;
    const scroll = await scrollGoogleMenuRegion(page, false);
    if (scroll.atBottom && stalledRounds >= 3) break;
    await page.waitForTimeout(menuScrollWaitMs);
  }

  // Read the final viewport once more because a scroll can trigger the last
  // virtualized batch immediately before the at-bottom condition is reached.
  for (const row of await extractVisibleMenuRows(page, categoryName, categoryNames)) {
    const key = `${row.name || ''}\u0000${row.displayedPrice || ''}\u0000${row.description || ''}`;
    if (!rowsByKey.has(key)) rowsByKey.set(key, row);
  }
  return [...rowsByKey.values()];
}

async function scrollGoogleMenuRegion(page, reset) {
  return page.evaluate((shouldReset) => {
    const visible = (element) => {
      const box = element?.getBoundingClientRect();
      return Boolean(box && box.width > 0 && box.height > 0);
    };
    const region = [...document.querySelectorAll('[role="region"][aria-label]')]
      .find((element) => /^menu$/i.test((element.getAttribute('aria-label') || '').trim())
        && visible(element));
    if (!region) return { found: false, atBottom: false, moved: false };

    const candidates = [region, ...region.querySelectorAll('*')];
    let ancestor = region.parentElement;
    while (ancestor && ancestor !== document.body) {
      candidates.push(ancestor);
      if (ancestor.getAttribute('role') === 'main') break;
      ancestor = ancestor.parentElement;
    }

    const scrollable = [...new Set(candidates)]
      .filter((element) => visible(element)
        && element.clientHeight >= 100
        && element.scrollHeight > element.clientHeight + 20)
      .sort((left, right) => {
        const leftStyle = getComputedStyle(left).overflowY;
        const rightStyle = getComputedStyle(right).overflowY;
        const leftScore = /auto|scroll/.test(leftStyle) ? 1 : 0;
        const rightScore = /auto|scroll/.test(rightStyle) ? 1 : 0;
        return rightScore - leftScore
          || (right.scrollHeight - right.clientHeight) - (left.scrollHeight - left.clientHeight);
      })[0];

    if (!scrollable) return { found: false, atBottom: true, moved: false };
    const before = scrollable.scrollTop;
    if (shouldReset) scrollable.scrollTo(0, 0);
    else scrollable.scrollBy(0, Math.max(Math.floor(scrollable.clientHeight * 0.8), 450));
    const after = scrollable.scrollTop;
    return {
      found: true,
      moved: after !== before,
      scrollTop: after,
      scrollHeight: scrollable.scrollHeight,
      clientHeight: scrollable.clientHeight,
      atBottom: after + scrollable.clientHeight >= scrollable.scrollHeight - 5,
    };
  }, reset);
}

async function extractVisibleMenuRows(page, categoryName, categoryNames) {
  return page.evaluate((input) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const linesOf = (element) => (element.innerText || '')
      .split(/\n+/)
      .map(clean)
      .filter(Boolean);
    const ignored = /^(overview|menu|about|reviews?|photos?|order online|directions|save|nearby|share|popular|secure your spot)$/i;
    const ignoredCategories = new Set(input.categoryNames.map((name) => name.toLowerCase()));
    const menuRegion = [...document.querySelectorAll('[role="region"][aria-label]')]
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
    description: cleanMenuDescription(rawItem.description || inferredDescription, price.priceText),
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

async function extractGooglePhotos(page, canonicalUrl, requestLog, backgroundTask = null) {
  const totalStartedAt = Date.now();
  const photosById = new Map();
  const tabResultsByName = new Map();
  const photoDatesById = new Map();
  let backgroundTaskPromise = null;
  const startBackgroundTask = () => {
    if (!backgroundTaskPromise && backgroundTask) backgroundTaskPromise = backgroundTask();
  };
  const processingTabs = [...photoTabs].sort((left, right) => {
    const leftIsAll = normalizePhotoTabName(left) === 'all';
    const rightIsAll = normalizePhotoTabName(right) === 'all';
    return Number(rightIsAll) - Number(leftIsAll);
  });

  for (const tab of processingTabs) {
    const tabStartedAt = Date.now();
    const limit = photoLimitForTab(tab);
    const scanLimit = Math.max(limit, photoScanLimit);
    const discoveryStartedAt = Date.now();
    const tabResult = await collectGooglePhotoTab(page, canonicalUrl, tab, scanLimit);
    const discoveryDurationMs = Date.now() - discoveryStartedAt;
    let datedPhotos = tabResult.photos.map((photo) => ({
      ...photo,
      uploadDate: photoDatesById.get(photo.photoId) ?? null,
    }));
    const reusedUploadDates = datedPhotos.filter(({ uploadDate }) => uploadDate).length;
    let newlyCapturedUploadDates = 0;
    let dateDurationMs = 0;
    let dateError = null;
    let uploadDateRetryAttempts = 0;
    let uploadDatesRecoveredByRetry = 0;
    let uploadDateRetryError = null;

    if (tabResult.status === 'success' && photoCaptureUploadDate) {
      const orderedPhotos = datedPhotos
        .filter((photo) => photo.discoverySource === 'dom' && !photo.uploadDate)
        .sort((left, right) => (left.photoIndex ?? Number.MAX_SAFE_INTEGER)
          - (right.photoIndex ?? Number.MAX_SAFE_INTEGER))
        .map(({ photoId, photoIndex }) => ({ photoId, photoIndex }));
      const dateStartedAt = Date.now();
      try {
        const datesById = await collectGooglePhotoDates(
          page,
          canonicalUrl,
          tab,
          orderedPhotos,
          backgroundTaskPromise ? null : startBackgroundTask,
        );
        for (const [photoId, uploadDate] of datesById) {
          if (!uploadDate) continue;
          photoDatesById.set(photoId, uploadDate);
          newlyCapturedUploadDates += 1;
        }
        datedPhotos = datedPhotos.map((photo) => ({
          ...photo,
          uploadDate: photoDatesById.get(photo.photoId) ?? null,
        }));
      } catch (error) {
        dateError = error.message;
        requestLog.warning(`Photo upload dates failed for ${tab}: ${error.message}`);
      } finally {
        dateDurationMs = Date.now() - dateStartedAt;
      }
      // The background task uses the released main page while a short-lived
      // upload-date page works. Wait before the next photo tab reuses main.
      if (backgroundTaskPromise) await backgroundTaskPromise;
    }

    let selectedPhotos = datedPhotos
      .map((photo, originalOrder) => ({ photo, originalOrder }))
      .sort((left, right) => photoDateRank(right.photo.uploadDate)
        - photoDateRank(left.photo.uploadDate)
        || (left.photo.photoIndex ?? Number.MAX_SAFE_INTEGER)
          - (right.photo.photoIndex ?? Number.MAX_SAFE_INTEGER)
        || left.originalOrder - right.originalOrder)
      .slice(0, limit)
      .map(({ photo }) => photo);
    if (tabResult.status === 'success' && photoCaptureUploadDate) {
      const missingSelectedDates = selectedPhotos
        .filter((photo) => photo.discoverySource === 'dom' && !photo.uploadDate)
        .map(({ photoId, photoIndex }) => ({ photoId, photoIndex }));
      if (missingSelectedDates.length) {
        uploadDateRetryAttempts = 1;
        const retryStartedAt = Date.now();
        try {
          const retryDatesById = await collectGooglePhotoDates(
            page, canonicalUrl, tab, missingSelectedDates,
          );
          for (const [photoId, uploadDate] of retryDatesById) {
            if (!uploadDate) continue;
            if (!photoDatesById.has(photoId)) uploadDatesRecoveredByRetry += 1;
            photoDatesById.set(photoId, uploadDate);
          }
          selectedPhotos = selectedPhotos.map((photo) => ({
            ...photo,
            uploadDate: photoDatesById.get(photo.photoId) ?? photo.uploadDate,
          }));
        } catch (error) {
          uploadDateRetryError = error.message;
          requestLog.warning(`Missing photo-date retry failed for ${tab}: ${error.message}`);
        } finally {
          dateDurationMs += Date.now() - retryStartedAt;
        }
      }
    }
    const uploadDatesCaptured = selectedPhotos.filter(({ uploadDate }) => uploadDate).length;
    const metadataStatus = tabResult.status !== 'success'
      ? tabResult.status
      : !photoCaptureUploadDate
        ? 'disabled'
        : dateError || uploadDateRetryError || uploadDatesCaptured < selectedPhotos.length
          ? 'partial'
          : 'success';

    tabResultsByName.set(tab, {
      status: tabResult.status,
      attempts: tabResult.attempts,
      requestedLimit: limit,
      discoveredPhotoCount: tabResult.photos.length,
      photoCount: selectedPhotos.length,
      uploadDatesCaptured,
      uploadDatesReused: reusedUploadDates,
      uploadDatesNewlyCaptured: newlyCapturedUploadDates,
      uploadDateRetryAttempts,
      uploadDatesRecoveredByRetry,
      metadataStatus,
      error: tabResult.error,
      metadataError: [dateError, uploadDateRetryError].filter(Boolean).join('; ') || null,
      discoveryDurationMs,
      uploadDateDurationMs: dateDurationMs,
      durationMs: Date.now() - tabStartedAt,
    });
    for (const photo of selectedPhotos) {
      const existing = photosById.get(photo.photoId);
      if (existing) {
        if (!existing.tabs.includes(tab)) existing.tabs.push(tab);
        if (!existing.uploadDate && photo.uploadDate) existing.uploadDate = photo.uploadDate;
      } else {
        photosById.set(photo.photoId, { ...photo, tabs: [tab] });
      }
    }
    requestLog.info(
      `Photo tab ${tab}: status=${tabResult.status}, attempts=${tabResult.attempts}, `
      + `selected=${selectedPhotos.length}/${limit}, discovered=${tabResult.photos.length}, `
      + `dates=${uploadDatesCaptured}, reused=${reusedUploadDates}, `
      + `new=${newlyCapturedUploadDates}, duration=${formatDuration(Date.now() - tabStartedAt)}.`,
    );
  }

  const tabResults = Object.fromEntries(photoTabs
    .map((tab) => [tab, tabResultsByName.get(tab)]));
  const candidates = [...photosById.values()];
  const tabStatuses = Object.values(tabResults).map(({ status }) => status);
  const hasFailedTab = tabStatuses.some((status) => status === 'failed');
  const allTabsFailed = tabStatuses.length > 0
    && tabStatuses.every((status) => status === 'failed');
  const hasPartialMetadata = Object.values(tabResults)
    .some(({ metadataStatus }) => metadataStatus === 'partial');
  const photoScrape = {
    status: allTabsFailed
      ? 'failed'
      : hasFailedTab || hasPartialMetadata
        ? 'partial'
        : candidates.length
          ? 'success'
          : 'none',
    uploadDateCaptureEnabled: photoCaptureUploadDate,
    photoCount: candidates.length,
    tabs: tabResults,
    timing: {
      fullSizeProbeDurationMs: 0,
      totalDurationMs: 0,
    },
  };
  if (!candidates.length) {
    photoScrape.timing.totalDurationMs = Date.now() - totalStartedAt;
    return { photos: [], photoScrape };
  }

  const photos = candidates
    .map((photo, originalOrder) => ({ photo, originalOrder }))
    .sort((left, right) => photoDateRank(right.photo.uploadDate) - photoDateRank(left.photo.uploadDate)
      || left.originalOrder - right.originalOrder)
    .map(({ photo }) => photo);

  const probeStartedAt = Date.now();
  const probes = await probeFullSizePhotos(page, photos);
  const failedProbeIndexes = probes
    .map((probe, index) => (!probe?.loaded || !probe.width || !probe.height ? index : null))
    .filter((index) => index != null);
  let fullSizeRetryAttempts = 0;
  let fullSizeRecoveredByRetry = 0;
  if (failedProbeIndexes.length) {
    fullSizeRetryAttempts = 1;
    const retryPhotos = failedProbeIndexes.map((index) => photos[index]);
    await page.waitForTimeout(500);
    const retryProbes = await probeFullSizePhotos(page, retryPhotos);
    for (let retryIndex = 0; retryIndex < failedProbeIndexes.length; retryIndex += 1) {
      const originalIndex = failedProbeIndexes[retryIndex];
      const retryProbe = retryProbes[retryIndex];
      if (!retryProbe?.loaded || !retryProbe.width || !retryProbe.height) continue;
      probes[originalIndex] = retryProbe;
      fullSizeRecoveredByRetry += 1;
    }
  }
  photoScrape.timing.fullSizeProbeDurationMs = Date.now() - probeStartedAt;
  for (let index = 0; index < photos.length; index += 1) {
    const probe = probes[index];
    photos[index].fullSizeImageUrl = probe?.loaded ? probe.url : null;
    photos[index].width = probe?.loaded ? probe.width : null;
    photos[index].height = probe?.loaded ? probe.height : null;
    if (!probe?.loaded) photos[index].imageError = probe?.error || 'Full-size image did not load';
  }

  const failedPhotoMetadata = photos
    .filter((photo) => !photo.fullSizeImageUrl || !photo.width || !photo.height)
    .map((photo) => ({
      photoId: photo.photoId,
      tabs: photo.tabs,
      error: photo.imageError || 'Required full-size photo metadata is missing',
    }));
  photoScrape.fullSizeRetryAttempts = fullSizeRetryAttempts;
  photoScrape.fullSizeRecoveredByRetry = fullSizeRecoveredByRetry;
  photoScrape.failedPhotoMetadata = failedPhotoMetadata;
  if (failedPhotoMetadata.length) {
    if (photoScrape.status === 'success') photoScrape.status = 'partial';
    for (const failure of failedPhotoMetadata) {
      for (const tab of failure.tabs) {
        const tabResult = photoScrape.tabs[tab];
        if (!tabResult) continue;
        tabResult.metadataStatus = 'partial';
        tabResult.fullSizeMetadataStatus = 'partial';
        tabResult.fullSizeFailedPhotoIds ??= [];
        if (!tabResult.fullSizeFailedPhotoIds.includes(failure.photoId)) {
          tabResult.fullSizeFailedPhotoIds.push(failure.photoId);
        }
        tabResult.metadataError = [tabResult.metadataError, failure.error]
          .filter(Boolean).join('; ');
      }
    }
  } else {
    for (const tabResult of Object.values(photoScrape.tabs)) {
      tabResult.fullSizeMetadataStatus = tabResult.status === 'success' ? 'success' : tabResult.status;
      tabResult.fullSizeFailedPhotoIds = [];
    }
  }

  await page.goto('about:blank').catch(() => {});
  photoScrape.timing.totalDurationMs = Date.now() - totalStartedAt;

  return { photos, photoScrape };
}

function photoLimitForTab(tab) {
  const normalized = normalizePhotoTabName(tab);
  return photoTabLimits.get(normalized) ?? photoMaxPerPlace;
}

async function collectGooglePhotoTab(page, canonicalUrl, tab, scanLimit) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const photos = await collectGooglePhotoTabOnce(page, canonicalUrl, tab, scanLimit);
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

async function collectGooglePhotoTabOnce(page, canonicalUrl, tab, scanLimit) {
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await acceptConsentIfShown(page);
  await enforceGoogleSafety(page, { url: canonicalUrl, userData: {} });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  const heading = await page.locator('h1').first().innerText().catch(() => '');
  if (/can't reach the internet|something went wrong|no internet/i.test(heading)) {
    throw new Error(`Google Maps error page: ${heading}`);
  }
  if (!await openGooglePhotoGallery(page)) return [];
  if (!await clickGooglePhotoTab(page, tab)) return [];
  await page.locator('a.MIgS0d[data-photo-index]').first()
    .waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {});

  const photosById = new Map();
  let stalledRounds = 0;
  for (let round = 0; round < photoScrollRounds; round += 1) {
    const before = photosById.size;
    const loaded = await describeGoogleGalleryPhotos(page, scanLimit);
    for (const photo of loaded) {
      if (!photo.looksLikeVideo && !photosById.has(photo.photoId)) {
        photosById.set(photo.photoId, photo);
      }
    }
    stalledRounds = photosById.size === before ? stalledRounds + 1 : 0;
    if (photosById.size >= scanLimit) break;
    const scroll = await scrollGooglePhotoGallery(page);
    if (!scroll.found && stalledRounds >= 3) break;
    if (scroll.atBottom && stalledRounds >= 3) break;
    await page.waitForTimeout(650);
  }
  return [...photosById.values()];
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
  const normalized = normalizePhotoTabName(tab);
  const labelPattern = normalized === 'food & drink'
    ? 'food\\s*(?:&|and)\\s*drink'
    : escapeRegExp(tab);
  const pattern = new RegExp(`^\\s*${labelPattern}\\s*$`, 'i');
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
      if (scroller.scrollHeight > scroller.clientHeight + 20 && box.width > 0 && box.height > 0) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) return { found: false, atBottom: true };
    scroller.scrollBy(0, Math.max(Math.floor(scroller.clientHeight * 0.85), 650));
    return {
      found: true,
      atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5,
    };
  });
}

async function collectGooglePhotoDates(
  page,
  canonicalUrl,
  tab,
  orderedPhotos,
  onPageReleased = null,
) {
  if (!orderedPhotos.length) return new Map();
  const dates = new Map();
  const browserContext = page.context();
  await page.goto('about:blank').catch(() => {});
  onPageReleased?.();
  const batches = [];
  for (let batchStart = 0; batchStart < orderedPhotos.length; batchStart += photoDateBatchSize) {
    batches.push({
      batchStart,
      photos: orderedPhotos.slice(batchStart, batchStart + photoDateBatchSize),
    });
  }
  let batchCursor = 0;
  const worker = async () => {
    while (batchCursor < batches.length) {
      const batchIndex = batchCursor;
      batchCursor += 1;
      const { batchStart, photos: batch } = batches[batchIndex];
      const datePage = await browserContext.newPage();
      try {
        await datePage.setExtraHTTPHeaders({ 'Accept-Language': 'en-MY,en;q=0.9' });
        await openGooglePhotoDateViewer(datePage, canonicalUrl, tab, batch[0]);

        let previousFingerprint = null;
        let repeated = 0;
        for (let index = 0; index < batch.length; index += 1) {
          await datePage.waitForTimeout(photoDateWaitMs);
          const includeDiagnostics = photoDebug && batchStart === 0 && index === 0;
          const snapshot = await readGooglePhotoDateSnapshot(datePage, includeDiagnostics);
          if (photoDebug && batchStart === 0 && index === 0) {
            log.info(`Photo-date diagnostic for ${tab}`, {
              photoId: snapshot.photoId,
              dateText: snapshot.dateText,
              lines: snapshot.diagnosticLines,
              labels: snapshot.diagnosticLabels,
            });
          }
          const resolvedPhotoId = batch[index].photoId || snapshot.photoId;
          if (!resolvedPhotoId) break;
          if (snapshot.fingerprint === previousFingerprint) repeated += 1;
          else repeated = 0;
          if (repeated >= 2) break;
          previousFingerprint = snapshot.fingerprint;
          if (snapshot.dateText) {
            dates.set(resolvedPhotoId, parseGoogleUploadDate(snapshot.dateText));
          }

          const currentIndex = batch[index].photoIndex;
          const nextIndex = batch[index + 1]?.photoIndex;
          const steps = Number.isFinite(currentIndex) && Number.isFinite(nextIndex) && nextIndex > currentIndex
            ? nextIndex - currentIndex
            : 1;
          for (let step = 0; step < steps && index + 1 < batch.length; step += 1) {
            const next = datePage.locator('button[aria-label*="next" i]:visible').first();
            if (await next.isVisible().catch(() => false)) await next.click().catch(() => {});
            else await datePage.keyboard.press('ArrowRight').catch(() => {});
            // The next item waits before reading. Only pause here when another
            // intermediate click is needed to skip an omitted/video index.
            if (step + 1 < steps) await datePage.waitForTimeout(photoDateWaitMs);
          }
        }
      } finally {
        await datePage.close().catch(() => {});
      }
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(photoDateConcurrency, batches.length) },
    worker,
  ));
  return dates;
}

async function openGooglePhotoDateViewer(page, canonicalUrl, tab, photo) {
  await page.goto(canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await acceptConsentIfShown(page);
  await enforceGoogleSafety(page, { url: canonicalUrl, userData: {} });
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });
  if (!await openGooglePhotoGallery(page)) {
    throw new Error('The Google Maps photo gallery did not open for upload-date capture.');
  }
  const tabReady = await clickGooglePhotoTab(page, tab);
  if (!tabReady) throw new Error(`The ${tab} photo tab did not open for upload-date capture.`);
  await page.locator('a.MIgS0d[data-photo-index]').first()
    .waitFor({ state: 'visible', timeout: 10_000 });

  await resetGooglePhotoGallery(page);
  if (!await clickGoogleGalleryPhoto(page, photo)) {
    throw new Error(`Could not reopen photo index ${photo.photoIndex ?? 'unknown'} in the ${tab} tab.`);
  }
}

async function clickGoogleGalleryPhoto(page, photo) {
  let stalledRounds = 0;
  for (let round = 0; round < photoScrollRounds; round += 1) {
    const clicked = await page.evaluate(({ photoId, photoIndex }) => {
      const cards = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')];
      const card = cards.find((candidate) => [...candidate.querySelectorAll('[style]')]
        .some((element) => element.style.backgroundImage.includes(photoId)))
        || cards.find((candidate) => Number(candidate.dataset.photoIndex) === photoIndex);
      if (!card) return false;
      card.click();
      return true;
    }, photo).catch(() => false);
    if (clicked) return true;

    const before = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')];
      return {
        count: cards.length,
        maxIndex: cards.reduce((maximum, card) => {
          const index = Number(card.dataset.photoIndex);
          return Number.isFinite(index) ? Math.max(maximum, index) : maximum;
        }, -1),
      };
    }).catch(() => ({ count: 0, maxIndex: -1 }));
    const scroll = await scrollGooglePhotoGallery(page);
    const targetAppearedOrGalleryGrew = await page.waitForFunction(
      ({ photoId, photoIndex, previousCount, previousMaxIndex }) => {
        const cards = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')];
        const targetVisible = cards.some((candidate) => [...candidate.querySelectorAll('[style]')]
          .some((element) => element.style.backgroundImage.includes(photoId)))
          || cards.some((candidate) => Number(candidate.dataset.photoIndex) === photoIndex);
        if (targetVisible || cards.length > previousCount) return true;
        return cards.some((card) => Number(card.dataset.photoIndex) > previousMaxIndex);
      },
      {
        photoId: photo.photoId,
        photoIndex: photo.photoIndex,
        previousCount: before.count,
        previousMaxIndex: before.maxIndex,
      },
      { timeout: Math.max(1_200, Math.min(photoDateWaitMs * 6, 3_000)) },
    ).then(() => true).catch(() => false);

    stalledRounds = targetAppearedOrGalleryGrew ? 0 : stalledRounds + 1;
    // Google briefly reports the current lazy-loaded edge as the bottom. Only
    // stop after the edge remains unchanged across several growth waits.
    if ((!scroll.found || scroll.atBottom) && stalledRounds >= 3) break;
  }
  return false;
}

async function readGooglePhotoDateSnapshot(page, includeDiagnostics) {
  return page.evaluate((debug) => {
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
    const lines = document.body.innerText.split(/\n+/)
      .map((line) => line.replace(/\s+/g, ' ').trim());
    const labels = [...document.querySelectorAll('[aria-label]')]
      .map((element) => (element.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim());
    const dateText = lines.find((line) => /^Photo\s*[-–—]\s*.+/i.test(line))
      || labels.find((line) => /^Photo\s*[-–—]\s*.+/i.test(line))
      || lines.find((line) => /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2}$/i.test(line))
      || lines.find((line) => /^(?:(?:a|an|\d+)\s+(?:day|week|month|year)s?\s+ago|today|yesterday)$/i.test(line))
      || null;
    return {
      photoId,
      dateText,
      fingerprint: photoId || visibleImages[0]?.source || location.href,
      diagnosticLines: debug
        ? lines.filter((line) => /\b(?:ago|photo|uploaded|20\d{2})\b/i.test(line)).slice(0, 40)
        : [],
      diagnosticLabels: debug
        ? labels.filter((line) => /\b(?:ago|photo|uploaded|20\d{2})\b/i.test(line)).slice(0, 40)
        : [],
    };
  }, includeDiagnostics);
}

async function resetGooglePhotoGallery(page) {
  await page.evaluate(() => {
    const card = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')]
      .find((candidate) => {
        const box = candidate.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      });
    let scroller = card?.parentElement;
    while (scroller && scroller !== document.body) {
      const box = scroller.getBoundingClientRect();
      if (scroller.scrollHeight > scroller.clientHeight + 20 && box.width > 0 && box.height > 0) {
        scroller.scrollTo(0, 0);
        return;
      }
      scroller = scroller.parentElement;
    }
  }).catch(() => {});
  await page.waitForTimeout(500);
}


async function probeFullSizePhotos(page, photos) {
  const inputs = photos.map(({ sourceImageUrl }) => ({
    url: `${sourceImageUrl.replace(/=[^/]*$/, '')}=s0`,
  }));
  return page.evaluate(async ({ entries, concurrency }) => {
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
    // Keep concurrency bounded because full-size Google images can be large.
    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
    return results;
  }, { entries: inputs, concurrency: photoProbeConcurrency });
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

async function extractPopularTimes(page) {
  const rawDays = await page.evaluate(() => {
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const regions = [...document.querySelectorAll('[role="region"][aria-label]')];
    const region = regions.find((element) => /popular times at/i.test(element.getAttribute('aria-label') || ''));
    if (!region) return null;

    const containers = [region, ...region.querySelectorAll('*')];
    const chartContainer = containers.find((element) => {
      const children = [...element.children];
      if (children.length !== 7) return false;
      return children.some((child) =>
        child.querySelector('[role="img"][aria-label*="% busy at" i]')
        || /closed\s+(?:sun|mon|tues|wednes|thurs|fri|satur)days?/i.test(child.textContent || ''),
      );
    });
    if (!chartContainer) return null;

    return [...chartContainer.children].map((panel, dayIndex) => {
      const hours = [...panel.querySelectorAll('[role="img"][aria-label]')]
        .map((element) => element.getAttribute('aria-label')?.replace(/\s+/g, ' ').trim())
        .map((label) => {
          const match = label?.match(/(\d{1,3})%\s*busy at\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i);
          if (!match) return null;
          const busynessPercent = Number(match[1]);
          const hour12 = Number(match[2]);
          const minute = Number(match[3] || 0);
          const period = match[4].toLowerCase();
          const hour = (hour12 % 12) + (period === 'pm' ? 12 : 0);
          const time = `${hour12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${period}`;
          return { time, hour, minute, busynessPercent, label };
        })
        .filter(Boolean);

      return { day: dayNames[dayIndex], hours };
    });
  }).catch(() => null);

  if (!rawDays) return null;

  const days = rawDays.map((day) => {
    // Google often renders 0% outside opening hours. Keep those raw readings,
    // but do not call them the quietest period because they can mean closed.
    const activeHours = day.hours.filter(({ busynessPercent }) => busynessPercent > 0);
    const peakValue = activeHours.length
      ? Math.max(...activeHours.map(({ busynessPercent }) => busynessPercent))
      : null;
    const quietValue = activeHours.length
      ? Math.min(...activeHours.map(({ busynessPercent }) => busynessPercent))
      : null;
    return {
      ...day,
      peak: peakValue == null
        ? null
        : activeHours.filter(({ busynessPercent }) => busynessPercent === peakValue).map(summarizeBusyHour),
      quietest: quietValue == null
        ? null
        : activeHours.filter(({ busynessPercent }) => busynessPercent === quietValue).map(summarizeBusyHour),
    };
  });

  const activeReadings = days.flatMap((day) => day.hours
    .filter(({ busynessPercent }) => busynessPercent > 0)
    .map((hour) => ({ day: day.day, ...summarizeBusyHour(hour) })));
  const peakValue = activeReadings.length
    ? Math.max(...activeReadings.map(({ busynessPercent }) => busynessPercent))
    : null;
  const quietValue = activeReadings.length
    ? Math.min(...activeReadings.map(({ busynessPercent }) => busynessPercent))
    : null;

  return {
    source: 'google_maps',
    unit: 'relative_busyness_percent',
    days,
    overallPeak: peakValue == null
      ? null
      : activeReadings.filter(({ busynessPercent }) => busynessPercent === peakValue),
    overallQuietest: quietValue == null
      ? null
      : activeReadings.filter(({ busynessPercent }) => busynessPercent === quietValue),
  };
}

function summarizeBusyHour({ time, hour, minute, busynessPercent }) {
  return { time, hour, minute, busynessPercent };
}

function derivePeakHoursFromBreakdown(popularTimes) {
  const peakValue = popularTimes.overallPeak?.[0]?.busynessPercent;
  if (peakValue == null) return [];
  return popularTimes.days.flatMap((day) => day.hours
    .filter(({ busynessPercent }) => busynessPercent === peakValue)
    .map(({ label }) => `${day.day}: ${label}`));
}

function toCsv(items) {
  const columns = [
    'name', 'placeId', 'featureId', 'latitude', 'longitude', 'rating', 'area',
    'category', 'businessStatus', 'brandSize', 'numberOfOutlets',
    'address', 'contact', 'reviewCount', 'priceLevel', 'openingHours', 'menu', 'menuScrape',
    'popularTimes', 'peakHours', 'query', 'about', 'photos', 'photoScrape',
    'reviews', 'reviewScrape',
    'googleMapsUrl', 'scrapedAt',
  ];
  const escape = (value) => {
    const string = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${string.replaceAll('"', '""')}"`;
  };
  return `${columns.join(',')}\n${items.map((item) => columns.map((column) => escape(item[column])).join(',')).join('\n')}\n`;
}
