import assert from 'node:assert/strict';
import test from 'node:test';
import { acceptGoogleConsentIfShown } from '../src/google-ui-utils.js';

test('accepts the first visible Google consent button', async () => {
  const clicked = [];
  const waits = [];
  const page = {
    getByRole: (_role, { name }) => ({
      first: () => ({
        isVisible: async () => name.test('Accept all'),
        click: async () => clicked.push('accept'),
      }),
    }),
    waitForTimeout: async (value) => waits.push(value),
  };

  assert.equal(await acceptGoogleConsentIfShown(page), true);
  assert.deepEqual(clicked, ['accept']);
  assert.deepEqual(waits, [750]);
});

test('returns false when no consent button is visible', async () => {
  const page = {
    getByRole: () => ({ first: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async () => {},
  };
  assert.equal(await acceptGoogleConsentIfShown(page), false);
});
