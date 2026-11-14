import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import {
  buildOcrOverlaySvg,
  createOcrVisualization,
  ocrVisualizationFileName,
} from '../src/ocr-visualization.js';

test('creates a safe deterministic OCR visualization filename', () => {
  const first = ocrVisualizationFileName('photo/id:123');
  assert.match(first, /^photo_id_123-[a-f0-9]{12}-ocr\.jpg$/);
  assert.equal(first, ocrVisualizationFileName('photo/id:123'));
});

test('marks price lines differently in the OCR overlay', () => {
  const svg = buildOcrOverlaySvg({
    width: 200,
    height: 100,
    lines: [{ index: 0, points: [[1, 1], [50, 1], [50, 20], [1, 20]], confidence: 0.9, labelX: 1, labelY: 1 }],
    priceLineIndexes: new Set([0]),
    fontSize: 12,
    strokeWidth: 2,
  });
  assert.match(svg, />P1<\/text>/);
  assert.match(svg, /#ffb000/);
});

test('writes a viewable annotated JPEG', async () => {
  const directory = await mkdtemp(join(process.cwd(), 'test', 'ocr-visualization-'));
  try {
    const input = await sharp({
      create: { width: 160, height: 90, channels: 3, background: '#ffffff' },
    }).png().toBuffer();
    const outputPath = join(directory, 'annotated.jpg');
    const result = await createOcrVisualization({
      imageBuffer: input,
      lines: [{ text: 'Latte', confidence: 0.98, box: [10, 10, 80, 30] }],
      priceCandidates: [],
      outputPath,
    });
    assert.equal(result.lineCount, 1);
    assert.ok((await readFile(outputPath)).length > 0);
    assert.equal((await sharp(outputPath).metadata()).format, 'jpeg');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
