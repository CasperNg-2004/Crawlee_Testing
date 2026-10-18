import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { classifyMalaysiaBrand, loadMalaysiaBrandCatalog } from './brand-classifier.js';

const inputPath = resolve(
  process.env.CHAIN_CLASSIFICATION_INPUT?.trim() || 'output/restaurants.json',
);
const catalogPath = resolve(
  process.env.CHAIN_CLASSIFICATION_CATALOG?.trim() || 'config/malaysia-chain-counts.json',
);
const outputPath = resolve(
  process.env.CHAIN_CLASSIFICATION_OUTPUT?.trim() || 'output/restaurants-classified.json',
);
const csvOutputPath = resolve(
  process.env.CHAIN_CLASSIFICATION_CSV_OUTPUT?.trim()
    || replaceExtension(outputPath, '.csv'),
);

const records = await readJsonArray(inputPath, 'restaurant input');
const preparedCatalog = await loadMalaysiaBrandCatalog(catalogPath);
const classifications = records.map((record) => classifyMalaysiaBrand(record, preparedCatalog));

const classifiedRecords = records.map((record, index) =>
  formatClassifiedRecord(normalizeContact(record), classifications[index]));

await mkdir(dirname(outputPath), { recursive: true });
await mkdir(dirname(csvOutputPath), { recursive: true });
await writeFileAtomic(outputPath, `${JSON.stringify(classifiedRecords, null, 2)}\n`);
await writeFileAtomic(csvOutputPath, toCsv(classifiedRecords));

const categoryCounts = new Map();
for (const record of classifiedRecords) {
  const category = record.brandSize || 'unverified';
  categoryCounts.set(category, (categoryCounts.get(category) || 0) + 1);
}

console.log(`Classified ${records.length} record(s) using Malaysia-only branch counts.`);
for (const category of [
  'independent',
  'small chain',
  'mid chain',
  'large chain',
  'huge chain',
  'unverified',
]) {
  console.log(`  ${category}: ${categoryCounts.get(category) || 0}`);
}
console.log(`JSON: ${outputPath}`);
console.log(`CSV:  ${csvOutputPath}`);

async function readJsonArray(path, label) {
  let value;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Could not read ${label} at ${path}: ${error.message}`);
  }
  if (!Array.isArray(value)) throw new Error(`${label} must be a JSON array: ${path}`);
  return value;
}

function formatClassifiedRecord(record, classification) {
  return {
    name: record.name ?? null,
    rating: record.rating ?? null,
    area: record.area ?? null,
    category: record.category ?? null,
    brandSize: classification.brandSize,
    numberOfOutlets: classification.numberOfOutlets,
    address: record.address ?? null,
    contact: record.contact ?? { phone: null, website: null },
    reviewCount: record.reviewCount ?? null,
    priceLevel: record.priceLevel ?? null,
    openingHours: record.openingHours ?? null,
    menu: record.menu ?? null,
    popularTimes: record.popularTimes ?? null,
    peakHours: record.peakHours ?? null,
    query: record.query ?? null,
    about: record.about ?? null,
    photos: record.photos ?? null,
    photoScrape: record.photoScrape ?? null,
    googleMapsUrl: record.googleMapsUrl ?? null,
    scrapedAt: record.scrapedAt ?? null,
  };
}

function normalizeContact(record) {
  const {
    phone,
    website,
    contact,
    latitude: ignoredLatitude,
    longitude: ignoredLongitude,
    plusCode: ignoredPlusCode,
    brand: ignoredBrand,
    brandSize: ignoredBrandSize,
    numberOfOutlets: ignoredNumberOfOutlets,
    count: ignoredCount,
    ...rest
  } = record;
  return {
    ...rest,
    contact: {
      phone: contact?.phone ?? phone ?? null,
      website: contact?.website ?? website ?? null,
    },
  };
}

function replaceExtension(path, extension) {
  const currentExtension = extname(path);
  return currentExtension ? `${path.slice(0, -currentExtension.length)}${extension}` : `${path}${extension}`;
}

function toCsv(items) {
  const columns = [...new Set(items.flatMap((item) => Object.keys(item)))];
  const escape = (value) => {
    const string = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${string.replaceAll('"', '""')}"`;
  };
  return `${columns.join(',')}\n${items.map((item) =>
    columns.map((column) => escape(item[column])).join(','),
  ).join('\n')}\n`;
}

async function writeFileAtomic(path, contents) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents, 'utf8');
  await rename(temporaryPath, path);
}
