import { readFile } from 'node:fs/promises';

export async function loadMalaysiaBrandCatalog(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read Malaysia chain catalog at ${path}: ${error.message}`);
  }
  if (!value || value.scope !== 'Malaysia' || !Array.isArray(value.brands)) {
    throw new Error('Chain catalog must contain { "scope": "Malaysia", "brands": [] }.');
  }
  return value.brands.map(prepareCatalogEntry);
}

export function classifyMalaysiaBrand(record, catalog) {
  const match = matchRecord(record, catalog);
  if (match.status !== 'matched') return { brandSize: null, numberOfOutlets: null };
  return {
    brandSize: classifyLocationCount(match.entry.malaysiaLocationCount),
    numberOfOutlets: match.entry.malaysiaLocationCount,
  };
}

function prepareCatalogEntry(entry, index) {
  const brand = cleanText(entry?.brand);
  const count = Number(entry?.malaysiaLocationCount);
  if (!brand) throw new Error(`Catalog brand at index ${index} has no valid brand name.`);
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`${brand}: malaysiaLocationCount must be a positive integer.`);
  }

  const exactNames = uniqueNormalized([brand, ...asStringArray(entry.aliases)]);
  const namePrefixes = uniqueNormalized(asStringArray(entry.namePrefixes));
  const websiteDomains = [...new Set(asStringArray(entry.websiteDomains)
    .map(normalizeDomain)
    .filter(Boolean))];

  return {
    brand,
    malaysiaLocationCount: count,
    exactNames,
    namePrefixes,
    websiteDomains,
  };
}

function matchRecord(record, catalog) {
  const recordName = normalizeName(record?.name);
  const recordDomain = normalizeDomain(record?.contact?.website ?? record?.website);
  const candidates = [];

  for (const entry of catalog) {
    let score = 0;
    if (recordDomain && entry.websiteDomains.includes(recordDomain)) {
      score = 300;
    } else if (recordName && entry.exactNames.includes(recordName)) {
      score = 200;
    } else if (entry.namePrefixes.some((prefix) =>
      recordName === prefix || recordName?.startsWith(`${prefix} `))) {
      score = 100;
    }
    if (score) candidates.push({ entry, score });
  }

  if (!candidates.length) return { status: 'unmatched', entry: null };
  const highestScore = Math.max(...candidates.map(({ score }) => score));
  const strongest = candidates.filter(({ score }) => score === highestScore);
  if (strongest.length !== 1) return { status: 'ambiguous', entry: null };
  return { status: 'matched', entry: strongest[0].entry };
}

function classifyLocationCount(count) {
  if (count === 1) return 'independent';
  if (count <= 5) return 'small chain';
  if (count <= 15) return 'mid chain';
  if (count <= 40) return 'large chain';
  return 'huge chain';
}

function asStringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function uniqueNormalized(values) {
  return [...new Set(values.map(normalizeName).filter(Boolean))];
}

function normalizeName(value) {
  return cleanText(value)
    ?.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || null;
}

function normalizeDomain(value) {
  const text = cleanText(value);
  if (!text) return null;
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    return url.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return text.toLowerCase().replace(/^www\./, '').split('/')[0] || null;
  }
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() || null : null;
}
