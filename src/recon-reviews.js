// Optional independent review diagnostic. Collection and validation are shared
// with the main scraper so Google selector fixes live in one place.
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
import { extractGoogleReviews, normalizeReviewSort } from './review-scraper.js';

const inputPath = resolve(process.env.RECON_REVIEWS_INPUT?.trim() || 'output/restaurants.json');
const outputRoot = resolve(process.env.RECON_REVIEWS_OUTPUT_DIR?.trim() || 'output/recon-reviews');
const chromeProfileDir = resolve(process.env.CHROME_PROFILE_DIR?.trim() || '.chrome-profile');
const placeLimit = positiveInteger(process.env.RECON_REVIEW_PLACE_LIMIT, 50);
const maxReviewsPerPlace = positiveInteger(process.env.RECON_REVIEW_MAX_PER_PLACE, 50);
const maxScrollRounds = positiveInteger(process.env.RECON_REVIEW_SCROLL_ROUNDS, 100);
const scrollWaitMs = positiveInteger(process.env.RECON_REVIEW_SCROLL_WAIT_MS, 250);
const sortOrder = normalizeReviewSort(process.env.RECON_REVIEW_SORT || 'newest');
const requestedPlaceNames = (process.env.RECON_REVIEW_PLACES?.trim() || '')
  .split('|')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const runStartedAt = new Date();
const runRoot = join(outputRoot, runStartedAt.toISOString().replace(/[:.]/g, '-'));

const savedPlaces = JSON.parse(await readFile(inputPath, 'utf8'));
if (!Array.isArray(savedPlaces)) throw new Error(`${inputPath} must contain a JSON array.`);

const places = savedPlaces
  .filter((place) => place?.googleMapsUrl)
  .filter((place) => !requestedPlaceNames.length
    || requestedPlaceNames.includes(place.name?.trim().toLowerCase()))
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
console.log(
  `Review recon: ${places.length} place(s), up to ${maxReviewsPerPlace} reviews each, sort=${sortOrder}.`,
);
console.log('Reviewer details and owner responses will not be collected.');

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
  const { reviews, reviewScrape } = await extractGoogleReviews(page, place, {
    maxReviews: maxReviewsPerPlace,
    maxScrollRounds,
    scrollWaitMs,
    sort: sortOrder,
  });
  const status = reviewScrape.status === 'failed' && reviews.length
    ? 'partial'
    : reviewScrape.status;
  const loadedUrl = page.url();

  return {
    placeName: place.name ?? null,
    googleMapsUrl: loadedUrl && loadedUrl !== 'about:blank' ? loadedUrl : place.googleMapsUrl,
    sourceArea: place.area ?? null,
    sourceQuery: place.query ?? null,
    availableReviewCount: reviewScrape.availableReviewCount,
    requestedReviewCount: maxReviewsPerPlace,
    targetReviewCount: reviewScrape.requestedReviewCount,
    scrapedReviewCount: reviewScrape.scrapedReviewCount,
    sort: reviewScrape.sort,
    status,
    attempts: reviewScrape.attempts,
    stalledScrolls: reviewScrape.stalledScrolls,
    newestOrderViolations: reviewScrape.newestOrderViolations,
    unexpandedReviewCount: reviewScrape.unexpandedReviewCount,
    reviewerDetailsCollected: false,
    ownerResponsesCollected: false,
    reviews,
    error: reviewScrape.error,
    scrapedAt: reviewScrape.scrapedAt,
  };
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
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
