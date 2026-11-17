import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createPhotoOcrCacheKey,
  readPhotoOcrCache,
  writePhotoOcrCache,
} from '../src/photo-ocr-cache.js';

const settings = {
  photoId: 'photo-1',
  imageUrl: 'https://example.test/photo=w1800-h1800',
  engine: 'paddleocr',
  imageSize: 1800,
  modelSize: 'small',
  languages: null,
};

test('OCR cache key changes when source or recognition settings change', () => {
  const baseline = createPhotoOcrCacheKey(settings);
  assert.equal(baseline, createPhotoOcrCacheKey(settings));
  assert.notEqual(baseline, createPhotoOcrCacheKey({ ...settings, imageSize: 1400 }));
  assert.notEqual(baseline, createPhotoOcrCacheKey({ ...settings, imageUrl: `${settings.imageUrl}&v=2` }));
});

test('OCR cache stores successful results without run-specific metadata', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test', 'photo-ocr-cache-'));
  const key = createPhotoOcrCacheKey(settings);
  try {
    assert.equal(await readPhotoOcrCache(directory, key), null);
    assert.equal(await writePhotoOcrCache(directory, key, {
      status: 'success',
      text: 'Latte RM 12',
      elapsedSeconds: 1.5,
      cache: { status: 'miss' },
      visualization: { status: 'deferred' },
    }), true);
    assert.deepEqual(await readPhotoOcrCache(directory, key), {
      status: 'success',
      text: 'Latte RM 12',
      elapsedSeconds: 1.5,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('OCR cache does not retain failed recognition', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test', 'photo-ocr-cache-'));
  try {
    assert.equal(await writePhotoOcrCache(directory, 'failed', { status: 'failed' }), false);
    assert.equal(await readPhotoOcrCache(directory, 'failed'), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
