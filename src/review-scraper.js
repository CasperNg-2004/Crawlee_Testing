export async function extractGoogleReviews(page, place, options = {}) {
  const maxReviews = positiveInteger(options.maxReviews, 50);
  const maxScrollRounds = positiveInteger(options.maxScrollRounds, 100);
  const scrollWaitMs = positiveInteger(options.scrollWaitMs, 250);
  const sort = normalizeReviewSort(options.sort || 'newest');
  const safetyCheck = options.safetyCheck || (async () => {});
  const knownAvailable = Number.isInteger(place.reviewCount) && place.reviewCount >= 0
    ? place.reviewCount
    : null;
  const targetReviewCount = knownAvailable == null
    ? maxReviews
    : Math.min(maxReviews, knownAvailable);
  let lastError = null;
  let bestAttempt = null;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      await page.goto(place.googleMapsUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await acceptConsentIfShown(page);
      await safetyCheck();
      const heading = page.locator('div[role="main"] h1, h1').first();
      await heading.waitFor({ state: 'visible', timeout: 25_000 });
      const loadedName = clean(await heading.textContent());
      if (/can't reach the internet|something went wrong|no internet/i.test(loadedName || '')) {
        throw new Error(`Google Maps error page: ${loadedName}`);
      }

      const opened = await openReviewsSection(page);
      await safetyCheck();
      if (!opened) {
        if (knownAvailable === 0 || await hasConfirmedNoReviews(page)) {
          return reviewResult({
            status: 'none',
            tabExists: false,
            attempts: attempt,
            availableReviewCount: knownAvailable,
            targetReviewCount: 0,
            sort: null,
            reviews: [],
          });
        }
        throw new Error('Reviews section could not be opened.');
      }

      const appliedSort = await applyReviewSort(page, sort);
      if (targetReviewCount > 1 && appliedSort !== sort) {
        throw new Error(`Requested review sort "${sort}" could not be confirmed.`);
      }
      const collection = await collectReviews(page, {
        limit: maxReviews,
        maxScrollRounds,
        scrollWaitMs,
      });
      const attemptResult = reviewResult({
        status: 'success',
        tabExists: true,
        attempts: attempt,
        availableReviewCount: knownAvailable,
        targetReviewCount,
        sort: appliedSort,
        reviews: collection.reviews,
        stalledScrolls: collection.stalledScrolls,
        newestOrderViolations: collection.newestOrderViolations,
        unexpandedReviewCount: collection.unexpandedReviewCount,
      });
      if (!bestAttempt || attemptResult.scrapedReviewCount > bestAttempt.scrapedReviewCount) {
        bestAttempt = attemptResult;
      }

      if (collection.reviews.length) {
        const allowedOrderAmbiguities = Math.max(1, Math.floor(collection.reviews.length * 0.04));
        if (sort === 'newest' && collection.newestOrderViolations > allowedOrderAmbiguities) {
          throw new Error(
            `Newest review order failed validation at ${collection.newestOrderViolations} position(s).`,
          );
        }
        if (collection.unexpandedReviewCount > 0) {
          throw new Error(`${collection.unexpandedReviewCount} review text(s) remained expandable.`);
        }
        if (collection.reviews.length < targetReviewCount) {
          throw new Error(
            `Only ${collection.reviews.length}/${targetReviewCount} requested reviews loaded.`,
          );
        }
        return attemptResult;
      }

      if (await hasConfirmedNoReviews(page)) {
        return reviewResult({
          status: 'none',
          tabExists: true,
          attempts: attempt,
          availableReviewCount: knownAvailable,
          targetReviewCount: 0,
          sort: appliedSort,
          reviews: [],
          stalledScrolls: collection.stalledScrolls,
        });
      }

      throw new Error('Reviews section opened but no review cards loaded.');
    } catch (error) {
      if (/SAFETY_STOP\[/.test(error?.message || '')) throw error;
      lastError = error;
    }
  }

  return {
    reviews: bestAttempt?.reviews || [],
    reviewScrape: {
      ...(bestAttempt?.reviewScrape || reviewResult({
        status: 'failed',
        tabExists: null,
        attempts: 2,
        availableReviewCount: knownAvailable,
        targetReviewCount,
        sort,
        reviews: [],
      }).reviewScrape),
      status: 'failed',
      attempts: 2,
      targetMet: false,
      error: lastError?.message || 'Unknown review scrape failure',
      scrapedAt: new Date().toISOString(),
    },
  };
}

function reviewResult({
  status,
  tabExists,
  attempts,
  availableReviewCount,
  targetReviewCount,
  sort,
  reviews,
  stalledScrolls = null,
  newestOrderViolations = 0,
  unexpandedReviewCount = 0,
}) {
  return {
    reviews,
    reviewScrape: {
      status,
      tabExists,
      attempts,
      availableReviewCount,
      requestedReviewCount: targetReviewCount,
      scrapedReviewCount: reviews.length,
      targetMet: status === 'none' || reviews.length >= targetReviewCount,
      sort,
      stalledScrolls,
      newestOrderViolations,
      unexpandedReviewCount,
      reviewerDetailsCollected: false,
      ownerResponsesCollected: false,
      error: null,
      scrapedAt: new Date().toISOString(),
    },
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
    if (await waitForReviewInterface(page)) return true;
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

  const firstReviewId = await page.locator('div[data-review-id]').evaluateAll((cards) =>
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
  const candidates = [
    page.getByRole('menuitemradio', { name: label }).first(),
    page.getByRole('menuitem', { name: label }).first(),
    page.getByText(label, { exact: false }).first(),
  ];
  await Promise.race(candidates.map((candidate) =>
    candidate.waitFor({ state: 'visible', timeout: 3_000 }))).catch(() => {});
  let target = null;
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      target = candidate;
      break;
    }
  }
  if (!target) {
    await page.keyboard.press('Escape').catch(() => {});
    return 'google_default';
  }
  await target.click();
  if (firstReviewId) {
    await page.waitForFunction((previousId) => {
      const first = [...document.querySelectorAll('div[data-review-id]')]
        .find((card) => card.getBoundingClientRect().width && card.getBoundingClientRect().height
          && card.querySelector('[role="img"][aria-label*="star" i]'));
      return first?.getAttribute('data-review-id') !== previousId;
    }, firstReviewId, { timeout: 5_000 }).catch(() => {});
  }
  await page.waitForTimeout(750);
  return order;
}

async function collectReviews(page, { limit, maxScrollRounds, scrollWaitMs }) {
  const reviewsByKey = new Map();
  let stalledScrolls = 0;
  for (let round = 0; round <= maxScrollRounds; round += 1) {
    await expandVisibleReviewText(page, limit);
    const visibleReviews = await extractVisibleReviews(page);
    const before = reviewsByKey.size;
    for (const review of visibleReviews) {
      const key = review.reviewId || `${review.rating}\u0000${review.publishedText}\u0000${review.text}`;
      const existing = reviewsByKey.get(key);
      if (!existing || (review.text?.length || 0) > (existing.text?.length || 0)) {
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
  return {
    reviews: selected.map(({ textExpandable: _expandable, ...review }) => review),
    stalledScrolls,
    unexpandedReviewCount: selected.filter(({ textExpandable }) => textExpandable).length,
    newestOrderViolations: countReviewOrderViolations(selected),
  };
}

async function expandVisibleReviewText(page, limit) {
  const targets = await page.locator('div[data-review-id]').evaluateAll((cards, maximum) => {
    const isOwnerResponse = (element, card) => {
      for (let current = element; current && current !== card; current = current.parentElement) {
        const label = current.getAttribute?.('aria-label') || '';
        if (/response from (?:the )?owner/i.test(label) || current.classList?.contains('CDe7pd')) return true;
      }
      return false;
    };
    const reviewIds = [];
    for (const card of cards) {
      if (reviewIds.length >= maximum) break;
      const rect = card.getBoundingClientRect();
      if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= window.innerHeight) continue;
      const reviewText = [...card.querySelectorAll('.MyEned .wiI7pd, .wiI7pd, [data-expandable-section]')]
        .find((element) => !isOwnerResponse(element, card));
      const text = reviewText?.textContent?.trim() || '';
      if (!/(?:…|\.\.\.)$/.test(text)) continue;
      const controls = [...card.querySelectorAll('button, [role="button"]')]
        .filter((element) => !isOwnerResponse(element, card));
      const expander = controls.find((element) => {
        const controlText = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`;
        const action = element.getAttribute('jsaction') || '';
        const style = getComputedStyle(element);
        return style.display !== 'none' && style.visibility !== 'hidden'
          && (/review\.expandReview/.test(action)
            || element.classList.contains('w8nwRe')
            || /\b(?:more|see more|read more)\b/i.test(controlText));
      });
      if (!expander) continue;
      const reviewId = card.getAttribute('data-review-id');
      if (reviewId) reviewIds.push(reviewId);
    }
    return reviewIds;
  }, Math.min(limit, 50)).catch(() => []);

  let expanded = 0;
  for (const reviewId of targets) {
    const escapedId = reviewId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
    const card = page.locator(`div[data-review-id="${escapedId}"]`).first();
    const candidates = card.locator([
      'button[jsaction*="review.expandReview"]',
      'button.w8nwRe',
      'button:has-text("More")',
      '[role="button"]:has-text("More")',
    ].join(','));
    for (let index = 0; index < await candidates.count(); index += 1) {
      const candidate = candidates.nth(index);
      if (!await candidate.isVisible().catch(() => false)) continue;
      await candidate.click({ timeout: 2_000 })
        .catch(() => candidate.click({ force: true, timeout: 2_000 }).catch(() => {}));
      expanded += 1;
      break;
    }
  }
  if (expanded) await page.waitForTimeout(200);
}

async function extractVisibleReviews(page) {
  return page.locator('div[data-review-id]').evaluateAll((cards) => {
    const cleanText = (value) => value?.replace(/[\uE000-\uF8FF]/g, '')
      .replace(/\s+/g, ' ').trim() || null;
    const numberFromText = (value) => {
      const match = cleanText(value)?.match(/([\d,.]+)\s*([KMB])?/i);
      if (!match) return null;
      const amount = Number(match[1].replaceAll(',', ''));
      if (!Number.isFinite(amount)) return null;
      return amount * ({ K: 1_000, M: 1_000_000, B: 1_000_000_000 }[match[2]?.toUpperCase()] || 1);
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
      const ratingLabel = cleanText(card.querySelector('[role="img"][aria-label*="star" i]')
        ?.getAttribute('aria-label'));
      const parsedRating = Number(ratingLabel?.match(/\d+(?:[.,]\d+)?/)?.[0]?.replace(',', '.'));
      const reviewText = [...card.querySelectorAll('.MyEned .wiI7pd, .wiI7pd, [data-expandable-section]')]
        .find((element) => !isOwnerResponse(element, card));
      const text = cleanText(reviewText?.textContent);
      const hasVisibleExpander = [...card.querySelectorAll('button, [role="button"]')]
        .filter((element) => !isOwnerResponse(element, card))
        .some((element) => {
          const controlText = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`;
          const action = element.getAttribute('jsaction') || '';
          const style = getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden'
            && (/review\.expandReview/.test(action)
              || element.classList.contains('w8nwRe')
              || /\b(?:more|see more|read more)\b/i.test(controlText));
        });
      const likeButton = [...card.querySelectorAll('button[aria-label]')]
        .find((button) => /helpful|like/i.test(button.getAttribute('aria-label') || ''));
      return {
        reviewId: cleanText(card.getAttribute('data-review-id')),
        rating: Number.isFinite(parsedRating) && parsedRating >= 1 && parsedRating <= 5
          ? parsedRating : null,
        text,
        publishedText: cleanText(card.querySelector('.rsqaWe')?.textContent),
        likes: numberFromText(cleanText(likeButton?.textContent)
          || cleanText(likeButton?.getAttribute('aria-label'))),
        textExpandable: hasVisibleExpander && /(?:…|\.\.\.)$/.test(text || ''),
      };
    }).filter((review) => review.reviewId || review.text || review.rating || review.publishedText);
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
    if (!await button.isVisible().catch(() => false)) continue;
    await button.click();
    await page.waitForTimeout(750);
    return;
  }
}

export function normalizeReviewSort(value) {
  const normalized = value.trim().toLowerCase();
  if (['newest', 'relevant', 'highest', 'lowest'].includes(normalized)) return normalized;
  throw new Error(`Unsupported review sort: ${value}`);
}

export function countReviewOrderViolations(reviews) {
  let violations = 0;
  let previousAge = null;
  for (const review of reviews) {
    const age = relativeReviewAge(review.publishedText);
    if (age == null) continue;
    if (previousAge != null && age < previousAge) violations += 1;
    previousAge = age;
  }
  return violations;
}

export function relativeReviewAge(value) {
  const normalized = value?.toLowerCase() || '';
  if (/just now/.test(normalized)) return 0;
  const match = normalized.match(/(?:a|an|one|([\d,.]+))\s+(second|minute|hour|day|week|month|year)/);
  if (!match) return null;
  const amount = match[1] ? Number(match[1].replaceAll(',', '')) : 1;
  if (!Number.isFinite(amount)) return null;
  return amount * {
    second: 1,
    minute: 60,
    hour: 3_600,
    day: 86_400,
    week: 604_800,
    month: 2_629_800,
    year: 31_557_600,
  }[match[2]];
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function clean(value) {
  return value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
}
