import assert from 'node:assert/strict';
import test from 'node:test';
import {
  booleanValue,
  csvCell,
  numberOrNull,
  parseCsv,
  positiveInteger,
} from '../src/common-utils.js';

test('parses shared environment value types conservatively', () => {
  assert.equal(positiveInteger('4', 1), 4);
  assert.equal(positiveInteger('0', 1), 1);
  assert.equal(booleanValue('true', false), true);
  assert.equal(booleanValue('false', true), false);
  assert.equal(numberOrNull('12.50'), 12.5);
  assert.equal(numberOrNull('unknown'), null);
});

test('round-trips quoted CSV cells used by photo labels', () => {
  const csv = `name,note\n${csvCell('Cafe, One')},${csvCell('Line 1\nLine 2')}\n`;
  assert.deepEqual(parseCsv(csv), [{ name: 'Cafe, One', note: 'Line 1\nLine 2' }]);
});
