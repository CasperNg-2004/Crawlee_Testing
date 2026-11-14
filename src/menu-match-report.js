import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import {
  column,
  createSheet,
  EXCEL_FONT_NAME,
  hyperlink,
  styleLinkCell,
  styleStatusCell,
} from './excel-utils.js';
import { outputFile, outputRunForFile } from './output-paths.js';
const STATUS_COLORS = {
  MATCH: { fill: 'FFE2F0D9', font: 'FF375623' },
  PRICE_DIFF: { fill: 'FFFFF2CC', font: 'FF7F6000' },
  REVIEW: { fill: 'FFFCE4D6', font: 'FFC65911' },
  ONLY_GOOGLE: { fill: 'FFF4CCCC', font: 'FF9C0006' },
  ONLY_PHOTO: { fill: 'FFF4CCCC', font: 'FF9C0006' },
  PRICE_NOT_COMPARABLE: { fill: 'FFE7E6E6', font: 'FF595959' },
  COMPARED: { fill: 'FFE2F0D9', font: 'FF375623' },
  NO_GOOGLE_MENU: { fill: 'FFFFF2CC', font: 'FF7F6000' },
  GOOGLE_MENU_FAILED: { fill: 'FFF4CCCC', font: 'FF9C0006' },
  NO_MENU_PHOTOS: { fill: 'FFE7E6E6', font: 'FF595959' },
  PHOTOS_NOT_LINKED: { fill: 'FFFCE4D6', font: 'FFC65911' },
};

const METRIC_DEFINITIONS = {
  googleCoverage: 'Matched Google offers divided by all Google offers.',
  photoCoverage: 'Matched photo offers divided by all photo offers.',
  priceAgreement: 'Equal numeric prices divided by all numeric price comparisons.',
  reviewRate: 'REVIEW rows divided by all item rows.',
  meanNameScore: 'Mean fuzzy name score for accepted name pairs.',
  meanOcrConfidence: 'Mean OCR confidence for matched photo offers.',
  matchingPrecision: 'Correct predicted pairs divided by all predicted pairs.',
  matchingRecall: 'Correct predicted pairs divided by all verified true pairs.',
  matchingF1: 'Harmonic mean of measured matching precision and recall.',
  verdictAccuracy: 'Correct priceMatch verdicts divided by verified comparable pairs.',
};

export function buildMenuMatchReportData(result) {
  const summary = [];
  const items = [];
  const review = [];
  const photos = [];
  const metrics = [];
  const info = [];

  for (const place of result.places || []) {
    const counts = countStatuses(place.items || []);
    const matched = (place.items || []).filter((row) => row.google && row.photo).length;
    summary.push({
      place: place.placeName ?? null,
      placeId: place.placeId ?? null,
      area: place.area ?? null,
      placeStatus: place.placeStatus ?? null,
      googleDishes: place.metrics?.googleOffers ?? 0,
      photoDishes: place.metrics?.photoOffers ?? 0,
      matched,
      priceDiff: counts.PRICE_DIFF || 0,
      notComparable: counts.PRICE_NOT_COMPARABLE || 0,
      review: counts.REVIEW || 0,
      onlyGoogle: counts.ONLY_GOOGLE || 0,
      onlyPhoto: counts.ONLY_PHOTO || 0,
      googleCoverage: place.metrics?.googleCoverage ?? null,
      photoCoverage: place.metrics?.photoCoverage ?? null,
      priceAgreement: place.metrics?.priceAgreement ?? null,
      newestMenuPhotoDate: newestDate((place.photos || []).map((photo) => photo.uploadDate)),
      menuPhotosUsed: place.photos?.length ?? 0,
      mapsLink: place.googleMapsUrl ?? null,
    });

    for (const row of place.items || []) {
      const item = flattenItem(place, row);
      items.push(item);
      if (row.status === 'REVIEW' || row.status === 'PRICE_DIFF') {
        review.push({ ...item, decision: null, correctedName: null, correctedPrice: null, note: null });
      }
    }

    for (const photo of place.photos || []) {
      photos.push({
        place: place.placeName ?? null,
        placeId: place.placeId ?? null,
        file: photo.fileName ?? null,
        photoId: photo.photoId ?? null,
        uploadDate: photo.uploadDate ?? null,
        imageStatus: photo.imageStatus ?? null,
        itemsParsed: photo.itemsParsed ?? 0,
        itemsMatched: photo.itemsMatched ?? 0,
        pairingAmbiguous: photo.pairingAmbiguous ?? 0,
        unpairedPrices: photo.unpairedPrices ?? 0,
        photoLink: photo.fullSizeImageUrl ?? null,
      });
    }
  }

  for (const [metric, value] of Object.entries(result.metrics || {})) {
    if (['type', 'googleOffers', 'photoOffers', 'matchedOffers'].includes(metric)) continue;
    metrics.push({
      metric,
      value,
      type: 'estimated',
      sampleSize: result.counts?.itemRows ?? null,
      definition: METRIC_DEFINITIONS[metric] ?? null,
    });
  }
  if (result.evaluation?.status === 'measured') {
    for (const metric of ['matchingPrecision', 'matchingRecall', 'matchingF1', 'verdictAccuracy']) {
      metrics.push({
        metric,
        value: result.evaluation[metric] ?? null,
        type: 'measured',
        sampleSize: metric === 'verdictAccuracy'
          ? result.evaluation.verdictSampleSize
          : result.evaluation.sampleSize,
        definition: METRIC_DEFINITIONS[metric],
      });
    }
    for (const row of result.evaluation.thresholdSweep || []) {
      metrics.push({
        metric: `threshold ${row.acceptThreshold} F1`,
        value: row.f1,
        type: 'measured threshold sweep',
        sampleSize: result.evaluation.sampleSize,
        definition: `Precision ${formatMetric(row.precision)}; recall ${formatMetric(row.recall)}.`,
      });
    }
  }

  const inputs = result.inputFiles || {};
  info.push(
    { key: 'Run date', value: result.generatedAt ?? null },
    { key: 'Restaurants input', value: inputs.restaurants ?? null },
    { key: 'Structured menu input', value: inputs.structured ?? null },
    { key: 'Photo map', value: inputs.photoMap ?? null },
    { key: 'Ground truth', value: inputs.groundTruth ?? null },
    { key: 'Accept threshold', value: result.settings?.acceptThreshold ?? null },
    { key: 'Review threshold', value: result.settings?.reviewThreshold ?? null },
    { key: 'Close-alternative delta', value: result.settings?.closeAlternativeDelta ?? null },
    { key: 'Assignment', value: result.settings?.assignment ?? null },
    { key: 'Unlinked image count', value: result.unlinkedImages?.length ?? 0 },
  );
  for (const image of result.unlinkedImages || []) {
    info.push({
      key: `Unlinked image: ${image.fileName || '<unknown>'}`,
      value: [image.reason, image.placeId, image.photoId].filter(Boolean).join(' | '),
    });
  }
  info.push({ key: 'Status legend', value: 'MATCH green; PRICE_DIFF/REVIEW yellow-orange; ONLY_* red; not comparable grey.' });
  info.push({ key: 'Review decisions', value: 'Decision columns are manual notes only; this version does not apply them back automatically.' });

  return { summary, items, review, photos, metrics, info };
}

export async function writeMenuMatchReport(result, filePath) {
  const data = buildMenuMatchReportData(result);
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'KL Google Maps Menu Matcher';
  workbook.created = new Date();
  workbook.modified = new Date();

  try {
    writeSummarySheet(workbook, data.summary);
    writeItemsSheet(workbook, 'Items', data.items, false);
    writeItemsSheet(workbook, 'Review', data.review, true);
    writePhotosSheet(workbook, data.photos);
    writeMetricsSheet(workbook, data.metrics);
    writeInfoSheet(workbook, data.info);
    await workbook.xlsx.writeFile(temporaryPath);
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
  return Object.fromEntries(Object.entries(data).map(([name, rows]) => [name, rows.length]));
}

function flattenItem(place, row) {
  const google = row.google || {};
  const photo = row.photo || {};
  return {
    place: place.placeName ?? null,
    placeId: place.placeId ?? null,
    status: row.status ?? null,
    nameMatch: mark(row.nameMatch),
    priceMatch: mark(row.priceMatch),
    nameScore: row.nameScore ?? null,
    googleSection: google.section ?? null,
    googleName: google.name ?? null,
    googlePrice: google.priceText ?? numberText(google.priceValue),
    googleCurrency: google.currency ?? null,
    photoName: photo.name ?? null,
    photoPrice: photo.priceText ?? numberText(photo.priceValue),
    photoCurrency: photo.currency ?? null,
    variant: photo.variant ?? null,
    ocrConfidence: photo.ocrConfidence ?? null,
    photoDate: photo.uploadDate ?? null,
    photoFile: photo.fileName ?? null,
    photoLink: photo.fullSizeImageUrl ?? null,
    reasons: (row.reasons || []).join(' | ') || null,
  };
}

function writeSummarySheet(workbook, rows) {
  const columns = [
    column('Place', 'place', 34, true), column('Place ID', 'placeId', 28), column('Area', 'area', 18),
    column('Place status', 'placeStatus', 22), column('Google dishes', 'googleDishes', 14, false, '0'),
    column('Photo dishes', 'photoDishes', 13, false, '0'), column('Matched', 'matched', 10, false, '0'),
    column('Price diff', 'priceDiff', 11, false, '0'), column('Not comparable', 'notComparable', 15, false, '0'),
    column('Review', 'review', 10, false, '0'), column('Only Google', 'onlyGoogle', 12, false, '0'),
    column('Only photo', 'onlyPhoto', 11, false, '0'),
    column('Google coverage %', 'googleCoverage', 17, false, '0.0%'),
    column('Photo coverage %', 'photoCoverage', 16, false, '0.0%'),
    column('Price agreement %', 'priceAgreement', 17, false, '0.0%'),
    column('Newest menu photo date', 'newestMenuPhotoDate', 21),
    column('Menu photos used', 'menuPhotosUsed', 16, false, '0'), column('Maps link', 'mapsLink', 45),
  ];
  const sheet = createSheet(workbook, 'Summary', columns, 'FF1F4E78');
  for (const value of rows) {
    const row = sheet.addRow({ ...value, mapsLink: hyperlink(value.mapsLink) });
    styleStatusCell(row.getCell('placeStatus'), value.placeStatus, STATUS_COLORS);
    styleLinkCell(row.getCell('mapsLink'));
  }
}

function itemColumns(includeDecision) {
  const columns = [
    column('Place', 'place', 30, true), column('Place ID', 'placeId', 27), column('Status', 'status', 22),
    column('Name ✓', 'nameMatch', 9), column('Price ✓', 'priceMatch', 9),
    column('Name score', 'nameScore', 12, false, '0.000'), column('Google section', 'googleSection', 22, true),
    column('Google name', 'googleName', 34, true), column('Google price', 'googlePrice', 15),
    column('Google currency', 'googleCurrency', 13), column('Photo name', 'photoName', 34, true),
    column('Photo price', 'photoPrice', 15), column('Photo currency', 'photoCurrency', 13),
    column('Variant', 'variant', 14), column('OCR confidence', 'ocrConfidence', 15, false, '0.000'),
    column('Photo date', 'photoDate', 16), column('Photo file', 'photoFile', 38),
    column('Photo link', 'photoLink', 48), column('Reasons', 'reasons', 42, true),
  ];
  if (includeDecision) columns.push(
    column('Decision', 'decision', 13), column('Corrected name', 'correctedName', 32, true),
    column('Corrected price', 'correctedPrice', 16), column('Note', 'note', 42, true),
  );
  return columns;
}

function writeItemsSheet(workbook, name, rows, includeDecision) {
  const sheet = createSheet(workbook, name, itemColumns(includeDecision), includeDecision ? 'FFED7D31' : 'FF70AD47');
  for (const value of rows) {
    const row = sheet.addRow({ ...value, photoLink: hyperlink(value.photoLink) });
    styleStatusCell(row.getCell('status'), value.status, STATUS_COLORS);
    styleLinkCell(row.getCell('photoLink'));
    styleMarkCell(row.getCell('nameMatch'));
    styleMarkCell(row.getCell('priceMatch'));
  }
  if (includeDecision) {
    const decisionColumn = sheet.getColumn('decision').number;
    const lastRow = Math.max(rows.length + 1, 2);
    for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
      sheet.getCell(rowNumber, decisionColumn).dataValidation = {
        type: 'list', allowBlank: true, formulae: ['"Accept,Reject,Correct"'],
        showErrorMessage: true, errorTitle: 'Invalid decision', error: 'Choose Accept, Reject, or Correct.',
      };
    }
  }
}

function writePhotosSheet(workbook, rows) {
  const columns = [
    column('Place', 'place', 32, true), column('Place ID', 'placeId', 28), column('File', 'file', 40),
    column('Photo ID', 'photoId', 42), column('Upload date', 'uploadDate', 16),
    column('Image status', 'imageStatus', 14), column('Items parsed', 'itemsParsed', 13, false, '0'),
    column('Items matched', 'itemsMatched', 14, false, '0'),
    column('Pairing ambiguous', 'pairingAmbiguous', 17, false, '0'),
    column('Unpaired prices', 'unpairedPrices', 15, false, '0'), column('Photo link', 'photoLink', 50),
  ];
  const sheet = createSheet(workbook, 'Photos', columns, 'FF5B9BD5');
  for (const value of rows) {
    const row = sheet.addRow({ ...value, photoLink: hyperlink(value.photoLink) });
    styleLinkCell(row.getCell('photoLink'));
  }
}

function writeMetricsSheet(workbook, rows) {
  const columns = [
    column('Metric', 'metric', 28), column('Value', 'value', 18, false, '0.000'),
    column('Type', 'type', 24), column('Sample size', 'sampleSize', 14, false, '0'),
    column('Definition', 'definition', 80, true),
  ];
  const sheet = createSheet(workbook, 'Metrics', columns, 'FF8064A2');
  rows.forEach((value) => sheet.addRow(value));
}

function writeInfoSheet(workbook, rows) {
  const sheet = createSheet(workbook, 'Info', [column('Key', 'key', 38, true), column('Value', 'value', 110, true)], 'FFA5A5A5');
  rows.forEach((value) => sheet.addRow(value));
}

function countStatuses(rows) {
  return rows.reduce((counts, row) => {
    counts[row.status] = (counts[row.status] || 0) + 1;
    return counts;
  }, {});
}

function newestDate(values) {
  const usable = values.filter(Boolean);
  if (!usable.length) return null;
  const ranked = usable.map((value) => ({ value, rank: dateRank(value) })).filter((entry) => entry.rank !== null);
  if (!ranked.length) return null;
  ranked.sort((left, right) => right.rank - left.rank);
  return ranked[0].value;
}

function dateRank(value) {
  const iso = String(value).match(/^((?:19|20)\d{2})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/);
  if (iso) return Number(iso[1]) * 10000 + Number(iso[2] || 1) * 100 + Number(iso[3] || 1);
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
  const month = String(value).match(/^([A-Za-z]+)\.?\s+(?:(\d{1,2}),?\s+)?((?:19|20)\d{2})$/);
  if (!month) return null;
  const monthNumber = months[month[1].slice(0, 4).toLowerCase()] || months[month[1].slice(0, 3).toLowerCase()];
  return monthNumber ? Number(month[3]) * 10000 + monthNumber * 100 + Number(month[2] || 1) : null;
}

function styleMarkCell(cell) {
  if (!cell.value) return;
  const positive = cell.value === '✓';
  cell.font = { name: EXCEL_FONT_NAME, size: 11, bold: true, color: { argb: positive ? 'FF375623' : 'FF9C0006' } };
  cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function mark(value) {
  if (value === true) return '✓';
  if (value === false) return '✗';
  return null;
}

function numberText(value) {
  return typeof value === 'number' ? String(value) : null;
}

function formatMetric(value) {
  return typeof value === 'number' ? value.toFixed(3) : 'n/a';
}

async function main() {
  const inputPath = resolve(process.argv[2] || '');
  if (!process.argv[2]) throw new Error('Usage: npm run export:report -- <menu-matches.json>');
  const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
  const outputPath = outputFile(outputRunForFile(inputPath), 'xlsx', 'menu-check.xlsx');
  const counts = await writeMenuMatchReport(parsed, outputPath);
  console.log(`MENU_REPORT_SUMMARY ${JSON.stringify({ status: 'complete', output: outputPath, sheets: counts })}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`MENU_REPORT_ERROR ${error.message}`);
    process.exitCode = 1;
  });
}
