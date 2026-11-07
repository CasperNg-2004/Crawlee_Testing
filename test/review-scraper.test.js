import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countReviewOrderViolations,
  normalizeReviewSort,
  relativeReviewAge,
  reviewGrowthWaitMs,
  retainBestReviewAttempt,
} from '../src/review-scraper.js';

test('normalizes supported review sort values', () => {
  assert.equal(normalizeReviewSort(' Newest '), 'newest');
  assert.equal(normalizeReviewSort('highest'), 'highest');
  assert.throws(() => normalizeReviewSort('random'));
});

test('converts relative review dates to comparable ages', () => {
  assert.equal(relativeReviewAge('just now'), 0);
  assert.equal(relativeReviewAge('2 weeks ago'), 1_209_600);
  assert.equal(relativeReviewAge('a year ago'), 31_557_600);
  assert.equal(relativeReviewAge('May 2025'), null);
});

test('counts newest-order violations', () => {
  assert.equal(countReviewOrderViolations([
    { publishedText: 'a day ago' },
    { publishedText: '2 weeks ago' },
    { publishedText: '3 months ago' },
  ]), 0);
  assert.equal(countReviewOrderViolations([
    { publishedText: '2 weeks ago' },
    { publishedText: 'a day ago' },
  ]), 1);
});

test('retains the review attempt that loaded the most reviews', () => {
  const firstAttempt = {
    reviews: Array.from({ length: 10 }, (_, index) => ({ reviewId: `first-${index}` })),
    reviewScrape: { scrapedReviewCount: 10 },
  };
  const secondAttempt = {
    reviews: Array.from({ length: 20 }, (_, index) => ({ reviewId: `second-${index}` })),
    reviewScrape: { scrapedReviewCount: 20 },
  };

  assert.equal(retainBestReviewAttempt(null, firstAttempt), firstAttempt);
  assert.equal(retainBestReviewAttempt(firstAttempt, secondAttempt), secondAttempt);
  assert.equal(retainBestReviewAttempt(secondAttempt, firstAttempt), secondAttempt);
});

test('uses a bounded wait for lazy-loaded review batches', () => {
  assert.equal(reviewGrowthWaitMs(100), 1_000);
  assert.equal(reviewGrowthWaitMs(250), 1_500);
  assert.equal(reviewGrowthWaitMs(1_000), 2_500);
});
