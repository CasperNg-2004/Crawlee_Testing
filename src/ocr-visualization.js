import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import sharp from 'sharp';

export function ocrVisualizationFileName(photoId) {
  const rawId = String(photoId || 'unknown-photo');
  const safeId = rawId
    .normalize('NFKC')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^[_\.]+|[_\.]+$/g, '')
    // Keep the complete Windows output path comfortably below legacy MAX_PATH.
    .slice(0, 48) || 'unknown-photo';
  const digest = createHash('sha256').update(rawId).digest('hex').slice(0, 12);
  return `${safeId}-${digest}-ocr.jpg`;
}

export async function createOcrVisualization({
  imageBuffer,
  lines,
  priceCandidates = [],
  outputPath,
}) {
  if (!Buffer.isBuffer(imageBuffer) || !imageBuffer.length) {
    throw new Error('OCR visualization requires a non-empty image buffer.');
  }
  const metadata = await sharp(imageBuffer, { failOn: 'warning' }).metadata();
  const width = Number(metadata.width);
  const height = Number(metadata.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('OCR visualization could not determine the image dimensions.');
  }

  const normalizedLines = (Array.isArray(lines) ? lines : [])
    .map((line, index) => normalizeLine(line, index, width, height))
    .filter(Boolean);
  if (!normalizedLines.length) throw new Error('OCR visualization has no valid text boxes.');

  const priceLineIndexes = new Set((Array.isArray(priceCandidates) ? priceCandidates : [])
    .map((candidate) => Number(candidate?.lineIndex))
    .filter(Number.isInteger));
  const fontSize = Math.max(12, Math.min(26, Math.round(width / 85)));
  const strokeWidth = Math.max(2, Math.min(6, width / 600));
  const svg = buildOcrOverlaySvg({
    width,
    height,
    lines: normalizedLines,
    priceLineIndexes,
    fontSize,
    strokeWidth,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await sharp(imageBuffer, { failOn: 'warning' })
    .composite([{ input: Buffer.from(svg) }])
    .jpeg({ quality: 88, mozjpeg: true })
    .toFile(outputPath);

  return {
    width,
    height,
    lineCount: normalizedLines.length,
    priceLineCount: normalizedLines.filter((line) => priceLineIndexes.has(line.index)).length,
  };
}

export function buildOcrOverlaySvg({ width, height, lines, priceLineIndexes, fontSize, strokeWidth }) {
  const shapes = lines.map((line) => {
    const isPrice = priceLineIndexes.has(line.index);
    const color = isPrice ? '#ffb000' : '#00d8ff';
    const fill = isPrice ? '#ffb0002e' : '#00d8ff20';
    const points = line.points.map(([x, y]) => `${round(x)},${round(y)}`).join(' ');
    const labelX = Math.max(0, Math.min(width - fontSize, line.labelX));
    const labelY = Math.max(fontSize, Math.min(height, line.labelY));
    const label = `${isPrice ? 'P' : ''}${line.index + 1}`;
    return `<polygon points="${points}" fill="${fill}" stroke="${color}" stroke-width="${strokeWidth}"/>`
      + `<text x="${round(labelX)}" y="${round(labelY)}" font-family="Arial,sans-serif" `
      + `font-size="${fontSize}" font-weight="700" fill="#ffffff" stroke="#000000" `
      + `stroke-width="${Math.max(2, strokeWidth)}" paint-order="stroke">${escapeXml(label)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes}</svg>`;
}

function normalizeLine(line, index, width, height) {
  const points = normalizePolygon(line?.polygon, width, height)
    || normalizeBox(line?.box, width, height);
  if (!points) return null;
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  return {
    index,
    points,
    confidence: Number.isFinite(Number(line?.confidence)) ? Number(line.confidence) : null,
    labelX: Math.min(...xs),
    labelY: Math.min(...ys) - 4,
  };
}

function normalizePolygon(value, width, height) {
  if (!Array.isArray(value) || value.length < 3) return null;
  const points = value.map((point) => {
    if (!Array.isArray(point) || point.length < 2) return null;
    const x = Number(point[0]);
    const y = Number(point[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return [clamp(x, 0, width), clamp(y, 0, height)];
  });
  return points.every(Boolean) ? points : null;
}

function normalizeBox(value, width, height) {
  if (!Array.isArray(value) || value.length < 4) return null;
  const [rawX1, rawY1, rawX2, rawY2] = value.map(Number);
  if (![rawX1, rawY1, rawX2, rawY2].every(Number.isFinite)) return null;
  const x1 = clamp(Math.min(rawX1, rawX2), 0, width);
  const y1 = clamp(Math.min(rawY1, rawY2), 0, height);
  const x2 = clamp(Math.max(rawX1, rawX2), 0, width);
  const y2 = clamp(Math.max(rawY1, rawY2), 0, height);
  if (x2 <= x1 || y2 <= y1) return null;
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]];
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value) {
  return Math.round(value * 100) / 100;
}
