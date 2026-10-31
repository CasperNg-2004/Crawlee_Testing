import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanMenuDescription } from '../src/menu-utils.js';

test('removes a description that only duplicates the displayed price', () => {
  assert.equal(cleanMenuDescription('  RM 28.80 ', 'RM 28.80'), null);
});

test('preserves a genuine menu description', () => {
  assert.equal(
    cleanMenuDescription('Espresso with fresh milk', 'RM 12.00'),
    'Espresso with fresh milk',
  );
});

test('keeps missing descriptions null', () => {
  assert.equal(cleanMenuDescription(null, 'RM 12.00'), null);
});
