import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizePhotoTabName,
  parseGoogleUploadDate,
  photoDateRank,
} from '../src/photo-utils.js';

test('normalizes the Food and drink photo-tab alias', () => {
  assert.equal(normalizePhotoTabName(' Food and drink '), 'food & drink');
  assert.equal(normalizePhotoTabName('Food & drink'), 'food & drink');
});

test('parses Google photo dates without inventing missing precision', () => {
  assert.deepEqual(parseGoogleUploadDate('Photo – October 2026'), {
    text: 'October 2026', year: 2026, month: 10, day: null,
  });
  assert.deepEqual(parseGoogleUploadDate('25 Oct 2026'), {
    text: '25 Oct 2026', year: 2026, month: 10, day: 25,
  });
  assert.deepEqual(parseGoogleUploadDate('2 months ago'), {
    text: '2 months ago', year: null, month: null, day: null,
  });
});

test('ranks exact and relative dates newest first', () => {
  const now = Date.UTC(2026, 9, 27);
  const today = photoDateRank(parseGoogleUploadDate('today'), now);
  const twoWeeksAgo = photoDateRank(parseGoogleUploadDate('2 weeks ago'), now);
  const lastYear = photoDateRank(parseGoogleUploadDate('October 2025'), now);
  assert.ok(today > twoWeeksAgo);
  assert.ok(twoWeeksAgo > lastYear);
});
