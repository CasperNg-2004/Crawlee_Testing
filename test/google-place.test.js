import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGooglePlaceIdUrl,
  extractGooglePlaceMetadata,
  extractGooglePlaceMetadataFromText,
  googlePlaceIdentity,
  normalizeGooglePlaceInput,
  selectBestGooglePlaceUrl,
} from '../src/google-place.js';

const placeId = 'ChIJa1yDFxRJzDERfLtufF3j-VI';
const featureId = '0x31cc491417835c6b:0x52f9e35d7c6ebb7c';

test('builds an official Maps search URL from a place ID', () => {
  const url = new URL(buildGooglePlaceIdUrl(placeId, 'Silverfox Cafe KL'));
  assert.equal(url.pathname, '/maps/search/');
  assert.equal(url.searchParams.get('api'), '1');
  assert.equal(url.searchParams.get('query'), 'Silverfox Cafe KL');
  assert.equal(url.searchParams.get('query_place_id'), placeId);
  assert.equal(url.searchParams.get('hl'), 'en');
});

test('accepts and preserves the client query_place_id URL format', () => {
  const input = `https://www.google.com/maps/search/?api=1&query=Silverfox&query_place_id=${placeId}`;
  const url = new URL(normalizeGooglePlaceInput(input));
  assert.equal(url.searchParams.get('query_place_id'), placeId);
  assert.equal(url.searchParams.get('query'), 'Silverfox');
  assert.equal(url.searchParams.get('hl'), 'en');
});

test('extracts IDs and coordinates from a canonical Maps URL', () => {
  const input = `https://www.google.com/maps/place/Silverfox/@3.1573621,101.6998564,17z/data=!4m7!3m6!1s${featureId}!8m2!3d3.1573621!4d101.6998564!19s${placeId}`;
  assert.deepEqual(extractGooglePlaceMetadata(input), {
    placeId,
    featureId,
    latitude: 3.1573621,
    longitude: 101.6998564,
  });
  assert.equal(googlePlaceIdentity(input), `place-id:${placeId}`);
});

test('uses data coordinates when the at-coordinate segment is absent', () => {
  const input = `https://www.google.com/maps/place/Example/data=!4m4!3m3!1s${featureId}!3d3.1!4d101.7`;
  const metadata = extractGooglePlaceMetadata(input);
  assert.equal(metadata.latitude, 3.1);
  assert.equal(metadata.longitude, 101.7);
  assert.equal(metadata.featureId, featureId);
});

test('rejects non-Google URLs and invalid place IDs', () => {
  assert.throws(() => normalizeGooglePlaceInput('https://example.com/maps/place/test'), /Google Maps URL/);
  assert.throws(() => buildGooglePlaceIdUrl('not-a-place-id'), /Invalid Google place ID/);
});

test('prefers a canonical place URL with metadata over the API search URL', () => {
  const requested = `https://www.google.com/maps/search/?api=1&query=cafes&query_place_id=${placeId}`;
  const canonical = `https://www.google.com/maps/place/Silverfox+Cafe+KL/@3.1573621,101.6998564,17z/data=!4m7!3m6!1s${featureId}!8m2!3d3.1573621!4d101.6998564!19s${placeId}`;
  const unrelated = 'https://www.google.com/maps/place/Other+Cafe/@3.1,101.6,17z/data=!4m2!3m1!1s0x111:0x222';
  assert.equal(
    selectBestGooglePlaceUrl([unrelated, canonical], requested, 'Silverfox Cafe KL'),
    canonical,
  );
});

test('extracts metadata near a place ID from escaped Maps initialization text', () => {
  const state = String.raw`["other",[3.2,101.8],"ChIJother"],`
    + String.raw`["${placeId}","${featureId}",[null,null,3.1573621,101.6998564]]`;
  assert.deepEqual(extractGooglePlaceMetadataFromText(state, placeId), {
    placeId,
    featureId,
    latitude: 3.1573621,
    longitude: 101.6998564,
  });
});
