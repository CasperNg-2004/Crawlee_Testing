import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyGoogleSafetyState, isSuspiciousEmptyMenu } from '../src/safety.js';

test('detects unusual traffic and CAPTCHA pages', () => {
  assert.equal(
    classifyGoogleSafetyState({ bodyText: 'Our systems have detected unusual traffic from your computer network.' }).code,
    'unusual_traffic',
  );
  assert.equal(
    classifyGoogleSafetyState({ bodyText: '', hasCaptcha: true }).code,
    'captcha',
  );
});

test('detects a signed-out profile only when sign-in is required', () => {
  const snapshot = { bodyText: '', signInVisible: true, accountVisible: false };
  assert.equal(classifyGoogleSafetyState(snapshot).code, 'signed_out');
  assert.equal(classifyGoogleSafetyState(snapshot, { requireSignIn: false }), null);
});

test('does not flag a visible signed-in account', () => {
  assert.equal(classifyGoogleSafetyState({ signInVisible: false, accountVisible: true }), null);
});

test('only counts confirmed loaded empty menus as suspicious', () => {
  assert.equal(isSuspiciousEmptyMenu({ status: 'none', tabExists: true, itemCount: 0 }), true);
  assert.equal(isSuspiciousEmptyMenu({ status: 'none', tabExists: false, itemCount: 0 }), false);
  assert.equal(isSuspiciousEmptyMenu({ status: 'failed', tabExists: true, itemCount: 0 }), false);
});
