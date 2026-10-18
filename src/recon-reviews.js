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
const scrollWaitMs = positiveInteger(process.env.RECON_REVIEW_SCROLL_WAIT_MS, 250);
const sortOrder = normalizeSortOrder(process.env.RECON_REVIEW_SORT || 'newest');
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
  const knownAvailable = Number.isInteger(place.reviewCount) && place.reviewCount >= 0
    ? place.reviewCount
    : null;
  const targetReviewCount = knownAvailable == null
    ? maxReviewsPerPlace
    : Math.min(maxReviewsPerPlace, knownAvailable);

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
      if (targetReviewCount > 1 && appliedSort !== sortOrder) {
        throw new Error(`Requested review sort "${sortOrder}" could not be confirmed.`);
      }
      const collection = await collectReviews(page, maxReviewsPerPlace);
      if (collection.reviews.length) {
        const allowedOrderAmbiguities = Math.max(1, Math.floor(collection.reviews.length * 0.04));
        if (sortOrder === 'newest' && collection.newestOrderViolations > allowedOrderAmbiguities) {
          throw new Error(`Newest review order failed validation at ${collection.newestOrderViolations} position(s).`);
        }
        if (collection.unexpandedReviewCount > 0) {
          console.warn(`Unexpanded review diagnostics: ${JSON.stringify(collection.unexpandedReviewDiagnostics)}`);
          throw new Error(`${collection.unexpandedReviewCount} review text(s) remained expandable.`);
        }
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
          newestOrderViolations: collection.newestOrderViolations,
          unexpandedReviewCount: collection.unexpandedReviewCount,
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
          newestOrderViolations: 0,
          unexpandedReviewCount: 0,
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
    newestOrderViolations: null,
    unexpandedReviewCount: null,
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
    const hasCards = [...document.querySelectorAll('div[data-review-id]')]
      .some((card) => card.getBoundingClientRect().width && card.getBoundingClientRect().height
        && card.querySelector('[role="img"][aria-label*="star" i]'));
    const hasSort = [...document.querySelectorAll('button')]
      .some((button) => /sort reviews/i.test(button.getAttribute('aria-label') || ''));
    const noReviews = /no reviews yet|has no reviews/i.test(document.body.innerText);
    return hasCards || hasSort || noReviews;
  }, null, { timeout }).then(() => true).catch(() => false);
}

async function applyReviewSort(page, order) {
  await page.waitForFunction(() => [...document.querySelectorAll(
    'button[aria-label*="sort" i], [role="button"][aria-label*="sort" i], button[data-value*="sort" i]',
  )].some((element) => element.getBoundingClientRect().width && element.getBoundingClientRect().height),
  null, { timeout: 5_000 }).catch(() => {});
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

  const firstReviewIdBeforeSort = await page.locator('div[data-review-id]').evaluateAll((cards) =>
    cards.find((card) => card.getBoundingClientRect().width && card.getBoundingClientRect().height
      && card.querySelector('[role="img"][aria-label*="star" i]'))
      ?.getAttribute('data-review-id') || null).catch(() => null);
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
  await Promise.race([
    option.waitFor({ state: 'visible', timeout: 3_000 }),
    menuItem.waitFor({ state: 'visible', timeout: 3_000 }),
    fallback.waitFor({ state: 'visible', timeout: 3_000 }),
  ]).catch(() => {});
  const target = await option.isVisible().catch(() => false)
    ? option
    : await menuItem.isVisible().catch(() => false) ? menuItem : fallback;
  if (!await target.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'google_default';
  }

  await target.click();
  if (firstReviewIdBeforeSort) {
    await page.waitForFunction((previousId) => {
      const first = [...document.querySelectorAll('div[data-review-id]')]
        .find((card) => card.getBoundingClientRect().width && card.getBoundingClientRect().height
          && card.querySelector('[role="img"][aria-label*="star" i]'));
      return first?.getAttribute('data-review-id') !== previousId;
    },
    firstReviewIdBeforeSort, { timeout: 5_000 }).catch(() => {});
  }
  await page.waitForTimeout(750);
  return order;
}

async function collectReviews(page, limit) {
  const reviewsByKey = new Map();
  let stalledScrolls = 0;

  for (let round = 0; round <= maxScrollRounds; round += 1) {
    await expandVisibleReviewText(page, limit);
    const visibleReviews = await extractVisibleReviews(page);
    const before = reviewsByKey.size;
    for (const review of visibleReviews) {
      const key = review.reviewId || `${review.rating}\u0000${review.publishedText}\u0000${review.text}`;
      const existing = reviewsByKey.get(key);
      if (!existing
        || existing.textExpandable && !review.textExpandable
        || (review.text?.length || 0) > (existing.text?.length || 0)) {
        reviewsByKey.set(key, review);
      }
      if (reviewsByKey.size >= limit) break;
    }
    if (reviewsByKey.size >= limit) break;

    stalledScrolls = reviewsByKey.size === before ? stalledScrolls + 1 : 0;
    const scrollState = await scrollReviewFeed(page);
    if ((stalledScrolls >= 5 && scrollState.atBottom) || stalledScrolls >= 8) break;
    await page.waitForTimeout(scrollWaitMs);
  }

  const selected = [...reviewsByKey.values()].slice(0, limit);
  const unexpandedReviewCount = selected.filter(({ textExpandable }) => textExpandable).length;
  const unexpandedReviewDiagnostics = selected
    .filter(({ textExpandable }) => textExpandable)
    .map(({ reviewId, textExpanderDiagnostic }) => ({ reviewId, ...textExpanderDiagnostic }));
  const reviews = selected.map(({
    textExpandable: _textExpandable,
    textExpanderDiagnostic: _textExpanderDiagnostic,
    ...review
  }) => review);
  return {
    reviews,
    stalledScrolls,
    unexpandedReviewCount,
    unexpandedReviewDiagnostics,
    newestOrderViolations: countNewestOrderViolations(reviews),
  };
}

async function expandVisibleReviewText(page, limit) {
  const buttons = page.locator('div[data-review-id] .MyEned button[jsaction*="review.expandReview"]');
  for (let expanded = 0; expanded < Math.min(limit, 20); expanded += 1) {
    let target = null;
    for (let index = 0; index < await buttons.count(); index += 1) {
      const candidate = buttons.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      const shouldExpand = await candidate.evaluate((button) => {
        if (button.closest('.CDe7pd, [aria-label*="response from" i]')) return false;
        const rect = button.getBoundingClientRect();
        if (rect.bottom <= 0 || rect.top >= window.innerHeight) return false;
        const section = button.closest('.MyEned');
        const text = section?.querySelector('.wiI7pd, [data-expandable-section]')?.textContent?.trim() || '';
        return /(?:…|\.\.\.)$/.test(text);
      }).catch(() => false);
      if (shouldExpand) {
        target = candidate;
        break;
      }
    }
    if (!target) break;
    await target.click({ timeout: 2_000 }).catch(() => target.click({ force: true }).catch(() => {}));
    await page.waitForTimeout(100);
  }
}

async function extractVisibleReviews(page) {
  return page.locator('div[data-review-id]').evaluateAll((cards) => {
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

    return cards.filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight
        && card.querySelector('[role="img"][aria-label*="star" i]');
    }).map((card) => {
      const ratingLabel = clean(card.querySelector('[role="img"][aria-label*="star" i]')?.getAttribute('aria-label'));
      const parsedRating = Number(ratingLabel?.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.'));
      const textCandidates = [...card.querySelectorAll('.MyEned .wiI7pd, .wiI7pd, [data-expandable-section]')];
      const reviewText = textCandidates.find((element) => !isOwnerResponse(element, card));
      const publishedText = clean(card.querySelector('.rsqaWe')?.textContent);
      const likeButton = [...card.querySelectorAll('button[aria-label]')].find((button) =>
        /helpful|like/i.test(button.getAttribute('aria-label') || ''),
      );
      const likeSource = clean(likeButton?.textContent) || clean(likeButton?.getAttribute('aria-label'));
      const reviewExpander = [...card.querySelectorAll('button[jsaction*="review.expandReview"]')]
        .find((button) => !isOwnerResponse(button, card));
      const expanderRect = reviewExpander?.getBoundingClientRect();
      const reviewTextValue = clean(reviewText?.textContent);
      const reviewTextLooksTruncated = /(?:…|\.\.\.)$/.test(reviewTextValue || '');
      const expanderInViewport = Boolean(expanderRect
        && expanderRect.bottom > 0 && expanderRect.top < window.innerHeight);
      if (reviewExpander && reviewTextLooksTruncated && !expanderInViewport) return null;

      return {
        reviewId: clean(card.getAttribute('data-review-id')),
        rating: Number.isFinite(parsedRating) && parsedRating >= 1 && parsedRating <= 5
          ? parsedRating
          : null,
        text: reviewTextValue,
        publishedText,
        likes: numberFromText(likeSource),
        textExpandable: Boolean(reviewExpander && reviewTextLooksTruncated),
        textExpanderDiagnostic: reviewExpander ? {
          ariaLabel: clean(reviewExpander.getAttribute('aria-label')),
          text: clean(reviewExpander.textContent),
          jsaction: clean(reviewExpander.getAttribute('jsaction')),
          parentClass: clean(reviewExpander.parentElement?.className),
          grandparentClass: clean(reviewExpander.parentElement?.parentElement?.className),
          width: expanderRect?.width ?? null,
          height: expanderRect?.height ?? null,
          display: reviewExpander ? getComputedStyle(reviewExpander).display : null,
          visibility: reviewExpander ? getComputedStyle(reviewExpander).visibility : null,
          reviewTextLength: clean(reviewText?.textContent)?.length ?? 0,
          reviewTextEndsWithEllipsis: clean(reviewText?.textContent)?.endsWith('…') ?? false,
        } : null,
      };
    }).filter((review) => review
      && (review.reviewId || review.text || review.rating || review.publishedText));
  });
}

async function scrollReviewFeed(page) {
  return page.locator('div[data-review-id]').evaluateAll((cards) => {
    const visibleCards = cards.filter((card) => {
      const rect = card.getBoundingClientRect();
      return rect.width && rect.height && rect.bottom > 0 && rect.top < window.innerHeight
        && card.querySelector('[role="img"][aria-label*="star" i]');
    });
    const lastCard = visibleCards.at(-1);
    if (!lastCard) return { atBottom: false, foundScroller: false };
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
    scroller.scrollBy(0, Math.max(scroller.clientHeight * 0.8, 500));
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

function countNewestOrderViolations(reviews) {
  let violations = 0;
  let previousAge = null;
  for (const review of reviews) {
    const age = relativeDateAge(review.publishedText);
    if (age == null) continue;
    if (previousAge != null && age < previousAge) violations += 1;
    previousAge = age;
  }
  return violations;
}

function relativeDateAge(value) {
  const normalized = value?.toLowerCase() || '';
  if (/just now/.test(normalized)) return 0;
  const match = normalized.match(/(?:a|an|one|([\d,.]+))\s+(second|minute|hour|day|week|month|year)/);
  if (!match) return null;
  const amount = match[1] ? Number(match[1].replaceAll(',', '')) : 1;
  if (!Number.isFinite(amount)) return null;
  const seconds = {
    second: 1,
    minute: 60,
    hour: 3_600,
    day: 86_400,
    week: 604_800,
    month: 2_629_800,
    year: 31_557_600,
  }[match[2]];
  return amount * seconds;
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
