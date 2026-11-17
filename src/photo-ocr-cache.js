import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_SCHEMA_VERSION = 1;

export function createPhotoOcrCacheKey({
  photoId,
  imageUrl,
  engine,
  imageSize,
  modelSize,
  languages,
}) {
  const identity = {
    schemaVersion: CACHE_SCHEMA_VERSION,
    photoId: photoId || null,
    imageUrl: imageUrl || null,
    engine,
    imageSize,
    modelSize: modelSize || null,
    languages: Array.isArray(languages) ? languages : null,
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export async function readPhotoOcrCache(cacheDirectory, cacheKey) {
  try {
    const payload = JSON.parse(await readFile(cachePath(cacheDirectory, cacheKey), 'utf8'));
    if (payload?.schemaVersion !== CACHE_SCHEMA_VERSION) return null;
    if (!payload.result || !['success', 'none'].includes(payload.result.status)) return null;
    return payload.result;
  } catch {
    return null;
  }
}

export async function writePhotoOcrCache(cacheDirectory, cacheKey, result) {
  if (!result || !['success', 'none'].includes(result.status)) return false;
  await mkdir(cacheDirectory, { recursive: true });
  await writeFile(cachePath(cacheDirectory, cacheKey), `${JSON.stringify({
    schemaVersion: CACHE_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    result: cacheableResult(result),
  }, null, 2)}\n`, 'utf8');
  return true;
}

function cacheableResult(result) {
  const cached = { ...result };
  delete cached.cache;
  delete cached.visualization;
  return cached;
}

function cachePath(cacheDirectory, cacheKey) {
  return join(cacheDirectory, `${cacheKey}.json`);
}
