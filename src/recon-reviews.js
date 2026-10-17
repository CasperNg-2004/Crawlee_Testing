// One-off Google Maps review investigation script. It stays separate from the
// main scraper and reads places from the existing output/restaurants.json.
// Reviewer identities and owner responses are intentionally not collected.
//
// Run (close other Chrome windows using .chrome-profile first):
//   npm run recon:reviews
//
// Useful test overrides:
//   $env:RECON_REVIEW_PLACE_LIMIT = '2'
//   $env:RECON_REVIEW_MAX_PER_PLACE = '50'
//   npm run recon:reviews

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const inputPath = resolve(process.env.RECON_REVIEWS_INPUT?.trim() || 'output/restaurants.json');
const outputRoot = resolve(process.env.RECON_REVIEWS_OUTPUT_DIR?.trim() || 'output/recon-reviews');
const chromeProfileDir = resolve(process.env.CHROME_PROFILE_DIR?.trim() || '.chrome-profile');
const placeLimit = positiveInteger(process.env.RECON_REVIEW_PLACE_LIMIT, 50);
const maxReviewsPerPlace = positiveInteger(process.env.RECON_REVIEW_MAX_PER_PLACE, 50);
const maxScrollRounds = positiveInteger(process.env.RECON_REVIEW_SCROLL_ROUNDS, 100);
const scrollWaitMs = positiveInteger(process.env.RECON_REVIEW_SCROLL_WAIT_MS, 1_000);
const sortOrder = normalizeSortOrder(process.env.RECON_REVIEW_SORT || 'newest');
const runStartedAt = new Date();
const runRoot = join(outputRoot, runStartedAt.toISOString().replace(/[:.]/g, '-'));

const savedPlaces = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(savedPlaces)) throw new Error(`${inputPath} must contain a JSON array.`);

const places = savedPlaces
  .filter((place) => place?.googleMapsUrl)
  .slice(0, placeLimit);
if (!places.length) throw new Error(`No Google Maps place URLs were found in ${inputPath}.`);

await mkdir(runRoot, { recursive: true });
const context = await chromium.launchPersistentContext(chromeProfileDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-MY',
  args: ['--disable-background-mode'],
});
await context.setExtraHTTPHeaders({ 'Accept-Language': 'en-MY,en;q=0.9' });

const results = [];
console.log(`Review recon: ${places.length} place(s), up to ${maxReviewsPerPlace} reviews each, sort=${sortOrder}.`);
console.log(`Reviewer details and owner responses will not be collected.`);

try {
  const page = await context.newPage();
  for (const [index, place] of places.entries()) {
    const startedAt = Date.now();
    console.log(`\n[${index + 1}/${places.length}] ${place.name || place.googleMapsUrl}`);
    const result = await scrapePlaceReviews(page, place);
    result.elapsedMs = Date.now() - startedAt;
    results.push(result);

    const filename = `${String(index + 1).padStart(3, '0')}-${slugify(place.name || 'place')}.json`;
    await writeFile(join(runRoot, filename), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(`status=${result.status} reviews=${result.scrapedReviewCount}/${result.requestedReviewCount}`
      + ` attempts=${result.attempts} elapsed=${formatDuration(result.elapsedMs)}`
      + `${result.error ? ` error=${result.error}` : ''}`);
  }
  await page.close().catch(() => {});
} finally {
  await context.close().catch(() => {});
}

const summary = {
  startedAt: runStartedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  inputPath,
  requestedPlaces: places.length,
  requestedReviewsPerPlace: maxReviewsPerPlace,
  sort: sortOrder,
  privacy: {
    reviewerDetailsCollected: false,
    ownerResponsesCollected: false,
  },
  counts: {
    success: results.filter(({ status }) => status === 'success').length,
    partial: results.filter(({ status }) => status === 'partial').length,
    none: results.filter(({ status }) => status === 'none').length,
    failed: results.filter(({ status }) => status === 'failed').length,
    reviews: results.reduce((total, result) => total + result.scrapedReviewCount, 0),
  },
  places: results,
};

await writeFile(join(runRoot, 'reviews.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(`\nDone. Results: ${join(runRoot, 'reviews.json')}`);

async function scrapePlaceReviews(page, place) {
  let lastError = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(place.googleMapsUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await acceptConsentIfShown(page);
      const heading = page.locator('div[role="main"] h1, h1').first();
      await heading.waitFor({ state: 'visible', timeout: 25_000 });
      const loadedName = clean(await heading.textContent());
      if (/can't reach the internet|something went wrong|no internet/i.test(loadedName || '')) {
        throw new Error(`Google Maps error page: ${loadedName}`);
      }

      const opened = await openReviewsSection(page);
      if (!opened) throw new Error('Reviews section could not be opened.');

      const appliedSort = await applyReviewSort(page, sortOrder);
      const collection = await collectReviews(page, maxReviewsPerPlace);
      if (collection.reviews.length) {
        const knownAvailable = Number.isInteger(place.reviewCount) && place.reviewCount >= 0
          ? place.reviewCount
          : null;
        const targetReviewCount = knownAvailable == null
          ? maxReviewsPerPlace
          : Math.min(maxReviewsPerPlace, knownAvailable);
        return {
          placeName: loadedName || place.name || null,
          googleMapsUrl: page.url(),
          sourceArea: place.area ?? null,
          sourceQuery: place.query ?? null,
          availableReviewCount: place.reviewCount ?? null,
          requestedReviewCount: maxReviewsPerPlace,
          targetReviewCount,
          scrapedReviewCount: collection.reviews.length,
          sort: appliedSort,
          status: collection.reviews.length >= targetReviewCount ? 'success' : 'partial',
          attempts: attempt,
          stalledScrolls: collection.stalledScrolls,
          reviews: collection.reviews,
          error: null,
          scrapedAt: new Date().toISOString(),
        };
      }

      if (await hasConfirmedNoReviews(page)) {
        return {
          placeName: loadedName || place.name || null,
          googleMapsUrl: page.url(),
          sourceArea: place.area ?? null,
          sourceQuery: place.query ?? null,
          availableReviewCount: place.reviewCount ?? null,
          requestedReviewCount: maxReviewsPerPlace,
          targetReviewCount: 0,
          scrapedReviewCount: 0,
          sort: appliedSort,
          status: 'none',
          attempts: attempt,
          stalledScrolls: collection.stalledScrolls,
          reviews: [],
          error: null,
          scrapedAt: new Date().toISOString(),
        };
      }

      lastError = new Error('Reviews section opened but no review cards loaded.');
    } catch (error) {
      lastError = error;
    }
  }

  return {
    placeName: place.name ?? null,
    googleMapsUrl: place.googleMapsUrl,
    sourceArea: place.area ?? null,
    sourceQuery: place.query ?? null,
    availableReviewCount: place.reviewCount ?? null,
    requestedReviewCount: maxReviewsPerPlace,
    targetReviewCount: Number.isInteger(place.reviewCount)
      ? Math.min(maxReviewsPerPlace, place.reviewCount)
      : maxReviewsPerPlace,
    scrapedReviewCount: 0,
    sort: sortOrder,
    status: 'failed',
    attempts: 2,
    stalledScrolls: null,
    reviews: [],
    error: lastError?.message || 'Unknown review scrape failure',
    scrapedAt: new Date().toISOString(),
  };
}

async function openReviewsSection(page) {
  const candidates = [
    page.getByRole('tab', { name: /reviews?/i }).first(),
    page.locator('button[jsaction*="pane.rating.moreReviews"]').first(),
    page.getByRole('button', { name: /\breviews?\b/i }).first(),
  ];

  for (const candidate of candidates) {
    if (!await candidate.isVisible().catch(() => false)) continue;
    await candidate.click().catch(() => {});
    const loaded = await waitForReviewInterface(page);
    if (loaded) return true;
  }
  return waitForReviewInterface(page, 3_000);
}

async function waitForReviewInterface(page, timeout = 15_000) {
  return page.waitForFunction(() => {
    const hasCards = document.querySelectorAll('[data-review-id]').length > 0;
    const hasSort = [...document.querySelectorAll('button')]
      .some((button) => /sort reviews/i.test(button.getAttribute('aria-label') || ''));
    const noReviews = /no reviews yet|has no reviews/i.test(document.body.innerText);
    return hasCards || hasSort || noReviews;
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function applyReviewSort(page, order) {
  await page.waitForTimeout(750);
  const sortButtons = page.locator([
    'button[aria-label*="sort" i]',
    '[role="button"][aria-label*="sort" i]',
    'button[data-value*="sort" i]',
  ].join(','));
  let sortButton = null;
  for (let index = 0; index < await sortButtons.count(); index += 1) {
    const candidate = sortButtons.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      sortButton = candidate;
      break;
    }
  }
  if (!sortButton) return 'google_default';

  await sortButton.click();
  const label = {
    newest: /newest/i,
    relevant: /most relevant/i,
    highest: /highest rating/i,
    lowest: /lowest rating/i,
  }[order];
  const option = page.getByRole('menuitemradio', { name: label }).first();
  const menuItem = page.getByRole('menuitem', { name: label }).first();
  const fallback = page.getByText(label, { exact: false }).first();
  const target = await option.isVisible().catch(() => false)
    ? option
    : await menuItem.isVisible().catch(() => false) ? menuItem : fallback;
  if (!await target.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'google_default';
  }

  await target.click();
  await page.waitForTimeout(1_500);
  return order;
}

async function collectReviews(page, limit) {
  const reviewsByKey = new Map();
  let stalledScrolls = 0;

  for (let round = 0; round <= maxScrollRounds; round += 1) {
    await expandVisibleReviewText(page);
    const visibleReviews = await extractVisibleReviews(page);
    const before = reviewsByKey.size;
    for (const review of visibleReviews) {
      const key = review.reviewId || `${review.rating}\u0000${review.publishedText}\u0000${review.text}`;
      if (!reviewsByKey.has(key)) reviewsByKey.set(key, review);
      if (reviewsByKey.size >= limit) break;
    }
    if (reviewsByKey.size >= limit) break;

    stalledScrolls = reviewsByKey.size === before ? stalledScrolls + 1 : 0;
    const scrollState = await scrollReviewFeed(page);
    if ((stalledScrolls >= 5 && scrollState.atBottom) || stalledScrolls >= 8) break;
    await page.waitForTimeout(scrollWaitMs);
  }

  return { reviews: [...reviewsByKey.values()].slice(0, limit), stalledScrolls };
}

async function expandVisibleReviewText(page) {
  const buttons = page.locator([
    '[data-review-id] button[jsaction*="expandReview"]',
    '[data-review-id] button.w8nwRe',
  ].join(','));
  for (let expanded = 0; expanded < 60; expanded += 1) {
    const button = buttons.first();
    if (!await button.count()) break;
    if (await button.isVisible().catch(() => false)) {
      await button.click({ force: true }).catch(() => {});
    } else {
      break;
    }
  }
  await page.waitForTimeout(150);
}

async function extractVisibleReviews(page) {
  return page.locator('[data-review-id]').evaluateAll((cards) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const numberFromText = (value) => {
      const match = clean(value)?.match(/([\d,.]+)\s*([KMB])?/i);
      if (!match) return null;
      const amount = Number(match[1].replaceAll(',', ''));
      if (!Number.isFinite(amount)) return null;
      const multiplier = { K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase()] || 1;
      return amount * multiplier;
    };
    const isOwnerResponse = (element, card) => {
      for (let current = element; current && current !== card; current = current.parentElement) {
        const label = current.getAttribute?.('aria-label') || '';
        if (/response from (?:the )?owner/i.test(label) || current.classList?.contains('CDe7pd')) return true;
      }
      return false;
    };

    return cards.map((card) => {
      const ratingLabel = clean(card.querySelector('[role="img"][aria-label*="star" i]')?.getAttribute('aria-label'));
      const parsedRating = Number(ratingLabel?.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.'));
      const textCandidates = [...card.querySelectorAll('.MyEned .wiI7pd, .wiI7pd, [data-expandable-section]')];
      const reviewText = textCandidates.find((element) => !isOwnerResponse(element, card));
      const publishedText = clean(card.querySelector('.rsqaWe')?.textContent);
      const likeButton = [...card.querySelectorAll('button[aria-label]')].find((button) =>
        /helpful|like/i.test(button.getAttribute('aria-label') || ''),
      );
      const likeSource = clean(likeButton?.textContent) || clean(likeButton?.getAttribute('aria-label'));

      return {
        reviewId: clean(card.getAttribute('data-review-id')),
        rating: Number.isFinite(parsedRating) && parsedRating >= 1 && parsedRating <= 5
          ? parsedRating
          : null,
        text: clean(reviewText?.textContent),
        publishedText,
        likes: numberFromText(likeSource),
      };
    }).filter((review) => review.reviewId || review.text || review.rating || review.publishedText);
  });
}

async function scrollReviewFeed(page) {
  return page.locator('[data-review-id]').last().evaluate((lastCard) => {
    const candidates = [];
    for (let current = lastCard.parentElement; current && current !== document.body; current = current.parentElement) {
      const style = getComputedStyle(current);
      const scrollRange = current.scrollHeight - current.clientHeight;
      if (/(auto|scroll)/.test(style.overflowY) && scrollRange > 20) {
        candidates.push({ element: current, scrollRange });
      }
    }
    const selected = candidates.sort((left, right) => right.scrollRange - left.scrollRange)[0];
    if (!selected) {
      lastCard.scrollIntoView({ block: 'end' });
      return { atBottom: false, foundScroller: false };
    }
    const scroller = selected.element;
    lastCard.scrollIntoView({ block: 'end' });
    scroller.scrollTop = scroller.scrollHeight;
    return {
      atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 10,
      foundScroller: true,
    };
  }).catch(() => ({ atBottom: false, foundScroller: false }));
}

async function hasConfirmedNoReviews(page) {
  return page.locator('body').evaluate((body) =>
    /no reviews yet|has no reviews/i.test(body.innerText),
  ).catch(() => false);
}

async function acceptConsentIfShown(page) {
  for (const name of [/accept all/i, /agree/i]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(750);
      return;
    }
  }
}

function normalizeSortOrder(value) {
  const normalized = value.trim().toLowerCase();
  if (['newest', 'relevant', 'highest', 'lowest'].includes(normalized)) return normalized;
  throw new Error(`Unsupported RECON_REVIEW_SORT: ${value}`);
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function clean(value) {
  return value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
}

function slugify(value) {
  return value
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
    .slice(0, 80) || 'place';
}

function formatDuration(milliseconds) {
  const seconds = Math.floor(milliseconds / 1_000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
