import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countReviewOrderViolations,
  normalizeReviewSort,
  relativeReviewAge,
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
