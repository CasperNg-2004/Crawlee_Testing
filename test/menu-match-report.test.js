import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { buildMenuMatchReportData, writeMenuMatchReport } from '../src/menu-match-report.js';

const fixture = {
  generatedAt: '2026-11-14T00:00:00Z',
  inputFiles: { restaurants: 'restaurants.json', structured: 'structured-menu.json', photoMap: 'photo-map.csv' },
  settings: { acceptThreshold: 0.9, reviewThreshold: 0.75, closeAlternativeDelta: 0.03, assignment: 'deterministic_greedy' },
  counts: { itemRows: 2 },
  metrics: { type: 'estimated', googleCoverage: 1, photoCoverage: 1, priceAgreement: 0.5, reviewRate: 0.5 },
  evaluation: { status: 'not_evaluated' },
  unlinkedImages: [{ fileName: 'unknown.jpg', reason: 'no_exact_photo_link' }],
  places: [{
    placeId: 'ChIJexample', placeName: 'Example Cafe', area: 'KL', placeStatus: 'COMPARED',
    googleMapsUrl: 'https://maps.google.com/example',
    metrics: { googleOffers: 2, photoOffers: 2, googleCoverage: 1, photoCoverage: 1, priceAgreement: 0.5 },
    photos: [{
      fileName: 'menu.jpg', photoId: 'photo-1', uploadDate: 'Nov 2026', imageStatus: 'success',
      itemsParsed: 2, itemsMatched: 2, pairingAmbiguous: 1, unpairedPrices: 0,
      fullSizeImageUrl: 'https://example.com/menu.jpg',
    }],
    items: [{
      status: 'MATCH', nameMatch: true, priceMatch: true, nameScore: 1,
      google: { section: 'Coffee', name: 'Latte', priceText: 'RM 10.00', currency: 'MYR' },
      photo: { name: 'LATTE', priceText: '10.00', currency: null, ocrConfidence: 0.98,
        uploadDate: 'Nov 2026', fileName: 'menu.jpg', fullSizeImageUrl: 'https://example.com/menu.jpg' },
      reasons: [],
    }, {
      status: 'REVIEW', nameMatch: null, priceMatch: false, nameScore: 0.8,
      google: { section: 'Tea', name: 'Iced Tea', priceText: 'RM 8.00', currency: 'MYR' },
      photo: { name: 'ICE TEA', priceText: '9.00', currency: null, ocrConfidence: 0.8,
        uploadDate: 'Nov 2026', fileName: 'menu.jpg', fullSizeImageUrl: 'https://example.com/menu.jpg' },
      reasons: ['name_in_review_band'],
    }],
  }],
};

test('builds six reader-facing menu comparison sheets', () => {
  const data = buildMenuMatchReportData(fixture);
  assert.equal(data.summary.length, 1);
  assert.equal(data.items.length, 2);
  assert.equal(data.review.length, 1);
  assert.equal(data.photos.length, 1);
  assert.ok(data.metrics.length >= 4);
  assert.ok(data.info.some((row) => row.key.includes('Unlinked image')));
  assert.equal(data.items[0].nameMatch, '✓');
  assert.equal(data.items[1].nameMatch, null);
});

test('writes workbook structure, filters, links, and review dropdown', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test-menu-match-report-'));
  const output = join(directory, 'menu-check.xlsx');
  try {
    await writeMenuMatchReport(fixture, output);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(output);
    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name),
      ['Summary', 'Items', 'Review', 'Photos', 'Metrics', 'Info']);
    assert.ok(workbook.getWorksheet('Summary').autoFilter);
    const review = workbook.getWorksheet('Review');
    const decisionColumn = review.getRow(1).values.findIndex((value) => value === 'Decision');
    assert.deepEqual(review.getCell(2, decisionColumn).dataValidation.formulae,
      ['"Accept,Reject,Correct"']);
    const photoLink = workbook.getWorksheet('Photos').getCell('K2').value;
    assert.equal(photoLink.hyperlink, 'https://example.com/menu.jpg');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
