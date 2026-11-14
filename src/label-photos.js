// Local browser interface for manually validating photo categories.
// It reads the latest independent photo-analysis output and writes labels to
// config/photo-analysis-labels.csv, which analyze-photos.js already uses.

import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, resolve } from 'node:path';
import {
  booleanValue,
  conciseError,
  csvCell,
  fileExists,
  numberOrNull,
  parseCsv,
  positiveInteger,
} from './common-utils.js';
import {
  openBrowser,
  readJsonBody,
  send,
  sendJson,
  writeFileWithRetry,
} from './local-tool-utils.js';
import {
  findLatestOutputFile,
  findLatestPipelineFile,
  outputFile,
  outputRunForFile,
} from './output-paths.js';

const CATEGORIES = ['menu', 'food', 'interior', 'unknown'];
const host = '127.0.0.1';
const port = positiveInteger(process.env.PHOTO_LABEL_PORT, 3789);
const labelMode = (process.env.PHOTO_LABEL_MODE?.trim() || 'classification').toLowerCase();
if (!['classification', 'ocr'].includes(labelMode)) {
  throw new Error('PHOTO_LABEL_MODE must be "classification" or "ocr".');
}
const outputRoot = resolve(process.env.OUTPUT_ROOT?.trim() || 'output');
const legacyOutputRoot = resolve(
  process.env.PHOTO_ANALYSIS_OUTPUT_DIR?.trim() || 'output/photo-classification',
);
const explicitInput = process.env.PHOTO_LABEL_INPUT?.trim();
const shouldOpenBrowser = booleanValue(process.env.PHOTO_LABEL_OPEN_BROWSER, true);

const inputPath = explicitInput
  ? resolve(explicitInput)
  : await findLatestPipelineFile(outputRoot, [
    'photo-classification/json/photo-analysis.json',
    'photo-classification/photo-analysis.json',
  ]) || await findLatestCompletedAnalysis(legacyOutputRoot);
if (!inputPath) throw new Error(`No completed photo-analysis.json was found under ${outputRoot}.`);
const labelsPath = process.env.PHOTO_ANALYSIS_LABELS?.trim()
  ? resolve(process.env.PHOTO_ANALYSIS_LABELS.trim())
  : outputFile(outputRunForFile(inputPath), 'csv', 'photo-analysis-labels.csv');

const report = JSON.parse(await readFile(inputPath, 'utf8'));
const records = flattenPhotoRecords(report);
if (!records.length) throw new Error(`${inputPath} contains no photo records.`);
const recordById = new Map(records.map((record) => [record.photoId, record]));
const savedLabels = await loadLabels(labelsPath);
const labels = new Map(savedLabels
  .filter((label) => recordById.has(label.photoId))
  .map((label) => [label.photoId, label]));
let saveQueue = Promise.resolve();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, HTML, 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, { status: 'ok', records: records.length, labelled: labels.size });
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(response, 200, buildState());
    }
    if (request.method === 'GET' && url.pathname === '/api/export') {
      const csv = buildLabelsCsv(records, labels);
      response.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${basename(labelsPath)}"`,
        'Cache-Control': 'no-store',
      });
      return response.end(csv);
    }
    if (request.method === 'POST' && url.pathname === '/api/label') {
      const body = await readJsonBody(request);
      const photoId = String(body.photoId || '').trim();
      const actualCategory = String(body.actualCategory || '').trim().toLowerCase();
      if (!recordById.has(photoId)) return sendJson(response, 404, { error: 'Photo ID was not found.' });
      if (!CATEGORIES.includes(actualCategory)) {
        return sendJson(response, 400, { error: `Category must be one of: ${CATEGORIES.join(', ')}.` });
      }
      const record = recordById.get(photoId);
      labels.set(photoId, {
        restaurantName: record.restaurantName,
        photoId,
        imageUrl: record.imageUrl,
        predictedCategory: record.predictedCategory,
        confidence: record.confidence,
        actualCategory,
        expectedOcrText: cleanText(body.expectedOcrText) || '',
      });
      await queueSave();
      return sendJson(response, 200, {
        ok: true,
        labelled: labels.size,
        total: records.length,
        ocrEvaluation: ocrEvaluationSummary(),
      });
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/label/')) {
      const photoId = decodeURIComponent(url.pathname.slice('/api/label/'.length));
      if (!recordById.has(photoId)) return sendJson(response, 404, { error: 'Photo ID was not found.' });
      labels.delete(photoId);
      await queueSave();
      return sendJson(response, 200, { ok: true, labelled: labels.size, total: records.length });
    }
    return sendJson(response, 404, { error: 'Not found.' });
  } catch (error) {
    console.error(error);
    return sendJson(response, 500, { error: conciseError(error) });
  }
});

export { server };

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`${labelMode === 'ocr' ? 'OCR accuracy reviewer' : 'Photo labeller'} ready: ${url}`);
  console.log(`Input: ${inputPath}`);
  console.log(`Photos: ${records.length}; already labelled: ${labels.size}`);
  console.log(`Autosave: ${labelsPath}`);
  console.log('Press Ctrl+C to stop. Labels already selected remain saved.');
  if (shouldOpenBrowser) openBrowser(url);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nStopping photo labeller. Waiting for the latest save...');
    await saveQueue.catch(() => {});
    server.close(() => process.exit(0));
  });
}

function buildState() {
  const ocrEvaluation = ocrEvaluationSummary();
  return {
    mode: labelMode,
    inputFile: basename(inputPath),
    labelsFile: basename(labelsPath),
    categories: CATEGORIES,
    total: records.length,
    labelled: labels.size,
    ocrEligible: ocrEvaluation.eligibleImages,
    ocrReviewed: ocrEvaluation.labelledImages,
    ocrMeanCharacterAccuracy: ocrEvaluation.meanCharacterAccuracy,
    records: records.map((record) => ({
      ...record,
      actualCategory: labels.get(record.photoId)?.actualCategory || null,
      expectedOcrText: labels.get(record.photoId)?.expectedOcrText || '',
    })),
  };
}

function ocrEvaluationSummary() {
  const eligible = records.filter((record) =>
    labels.get(record.photoId)?.actualCategory === 'menu' && record.ocrText);
  const reviewed = eligible.filter((record) => labels.get(record.photoId)?.expectedOcrText);
  const accuracies = reviewed.map((record) => {
    const expected = normalizeEvaluationText(labels.get(record.photoId).expectedOcrText);
    const actual = normalizeEvaluationText(record.ocrText);
    if (!expected && !actual) return 1;
    return 1 - (levenshteinDistance(expected, actual) / Math.max(expected.length, actual.length));
  });
  return {
    eligibleImages: eligible.length,
    labelledImages: reviewed.length,
    meanCharacterAccuracy: accuracies.length
      ? accuracies.reduce((sum, value) => sum + value, 0) / accuracies.length
      : null,
  };
}

function normalizeEvaluationText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function levenshteinDistance(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitution = previous[rightIndex - 1]
        + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function flattenPhotoRecords(value) {
  const flattened = [];
  for (const restaurant of value.restaurants || []) {
    for (const [index, image] of (restaurant.images || []).entries()) {
      const imageUrl = image.analysisImageUrl || image.originalFullSizeImageUrl || null;
      if (!image.photoId || !imageUrl) continue;
      flattened.push({
        sequence: flattened.length + 1,
        restaurantPhotoIndex: index + 1,
        restaurantName: restaurant.name || 'Unknown restaurant',
        area: restaurant.area || null,
        photoId: image.photoId,
        imageUrl,
        fullSizeImageUrl: image.originalFullSizeImageUrl || imageUrl,
        predictedCategory: image.category || null,
        modelTopCategory: image.modelTopCategory || null,
        confidence: numberOrNull(image.confidence),
        confidenceLevel: image.confidenceLevel || null,
        margin: numberOrNull(image.margin),
        categoryScores: image.categoryScores || null,
        sourceTabs: Array.isArray(image.sourceTabs) ? image.sourceTabs : [],
        analysisStatus: image.analysisStatus || null,
        ocrEngine: image.ocr?.engine || (image.ocr ? 'tesseract' : null),
        ocrStatus: image.ocr?.status || null,
        ocrConfidence: numberOrNull(image.ocr?.confidence),
        ocrPriceCandidateCount: Array.isArray(image.ocr?.priceCandidates)
          ? image.ocr.priceCandidates.length
          : null,
        ocrElapsedSeconds: numberOrNull(image.ocr?.elapsedSeconds),
        ocrText: image.ocr?.text || null,
        originalWidth: numberOrNull(image.originalWidth),
        originalHeight: numberOrNull(image.originalHeight),
      });
    }
  }
  return flattened;
}

async function queueSave() {
  const csv = buildLabelsCsv(records, labels);
  const task = saveQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(labelsPath), { recursive: true });
    await writeLabelsWithRetry(csv);
  });
  // Keep future saves usable even when one request exhausts all retries.
  saveQueue = task.catch(() => {});
  return task;
}

async function writeLabelsWithRetry(csv) {
  try {
    await writeFileWithRetry(labelsPath, csv);
  } catch (error) {
    throw new Error(
      `Could not save labels after 10 attempts. Close ${basename(labelsPath)} if it is open in Excel, then choose the category again. ${conciseError(error)}`,
    );
  }
}

function buildLabelsCsv(allRecords, labelMap) {
  const header = [
    'restaurantName', 'photoId', 'imageUrl', 'predictedCategory', 'confidence',
    'actualCategory', 'expectedOcrText',
  ];
  const rows = allRecords
    .filter((record) => labelMap.has(record.photoId))
    .map((record) => {
      const label = labelMap.get(record.photoId);
      return [
        record.restaurantName,
        record.photoId,
        record.fullSizeImageUrl || record.imageUrl,
        record.predictedCategory,
        record.confidence,
        label.actualCategory,
        label.expectedOcrText || '',
      ];
    });
  return `${[header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

async function loadLabels(path) {
  if (!await fileExists(path)) return [];
  const text = await readFile(path, 'utf8');
  if (extname(path).toLowerCase() === '.json') {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : parsed.labels || [];
  }
  return parseCsv(text);
}

async function findLatestCompletedAnalysis(root) {
  return findLatestOutputFile(root, ['json/photo-analysis.json', 'photo-analysis.json']);
}

function cleanText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Photo category labeller</title>
  <style>
    :root { color-scheme: dark; --bg:#0b1220; --panel:#121c2f; --line:#28364f; --text:#eef4ff; --muted:#9cb0cc; --accent:#4ea8ff; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100vh; background:var(--bg); color:var(--text); font:14px/1.4 Arial,sans-serif; }
    button,select,input,textarea { font:inherit; }
    header { position:sticky; top:0; z-index:5; display:grid; grid-template-columns:minmax(260px,1fr) auto; gap:16px; padding:12px 18px; background:#0d1728f2; border-bottom:1px solid var(--line); backdrop-filter:blur(8px); }
    h1 { margin:0 0 2px; font-size:18px; }
    .muted { color:var(--muted); }
    .progress-wrap { min-width:310px; text-align:right; }
    .progress { height:8px; margin-top:7px; overflow:hidden; border-radius:8px; background:#26344b; }
    .progress > div { height:100%; width:0; background:linear-gradient(90deg,#4095e8,#56d3a2); transition:width .2s; }
    main { display:grid; grid-template-columns:minmax(0,1fr) 370px; gap:14px; padding:14px; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; }
    .viewer { min-height:calc(100vh - 110px); display:flex; flex-direction:column; overflow:hidden; }
    .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px 12px; border-bottom:1px solid var(--line); }
    select,input { color:var(--text); background:#18243a; border:1px solid #34435d; border-radius:7px; padding:7px 9px; }
    input { min-width:210px; }
    .image-stage { position:relative; flex:1; min-height:480px; display:flex; align-items:center; justify-content:center; padding:12px; background:#070c14; }
    .image-stage img { max-width:100%; max-height:calc(100vh - 235px); object-fit:contain; box-shadow:0 8px 35px #0008; }
    .image-error { display:none; max-width:520px; padding:24px; text-align:center; color:#ffb4ab; }
    .loading { position:absolute; padding:8px 12px; border-radius:7px; background:#000b; color:white; }
    .bottom-nav { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:10px 12px; border-top:1px solid var(--line); }
    button,.link-button { border:1px solid #3a4a67; border-radius:8px; padding:8px 12px; color:var(--text); background:#1a2942; cursor:pointer; text-decoration:none; }
    button:hover,.link-button:hover { border-color:#6b8ab6; background:#203553; }
    button:disabled { opacity:.4; cursor:not-allowed; }
    aside { padding:15px; overflow:auto; max-height:calc(100vh - 92px); }
    .restaurant { margin:0; font-size:21px; }
    .meta { margin:4px 0 14px; color:var(--muted); }
    .chips { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:14px; }
    .chip { border:1px solid #3a4a67; border-radius:999px; padding:4px 8px; color:#c9d7ec; }
    .model-box { padding:10px; background:#0c1626; border:1px solid var(--line); border-radius:9px; margin-bottom:14px; }
    .scores { display:grid; grid-template-columns:repeat(2,1fr); gap:5px 12px; margin-top:8px; font-size:12px; color:var(--muted); }
    .labels { display:grid; grid-template-columns:1fr 1fr; gap:9px; margin:10px 0 14px; }
    .label { padding:13px 8px; font-weight:bold; font-size:15px; }
    .label.selected { outline:3px solid white; outline-offset:1px; }
    .menu { background:#175cd3; }.food { background:#b54708; }.interior { background:#027a48; }.unknown { background:#475467; }
    textarea { width:100%; min-height:120px; resize:vertical; padding:9px; color:var(--text); background:#0c1626; border:1px solid #34435d; border-radius:8px; }
    .ocr-head { display:flex; justify-content:space-between; align-items:center; margin-top:10px; }
    .ocr-source { max-height:150px; overflow:auto; white-space:pre-wrap; padding:9px; background:#09111e; border:1px solid var(--line); border-radius:8px; color:#c9d7ec; }
    .status { min-height:22px; margin-top:8px; color:#65d6a8; }
    .shortcuts { margin-top:13px; padding-top:11px; border-top:1px solid var(--line); color:var(--muted); font-size:12px; }
    @media (max-width:900px) { main { grid-template-columns:1fr; } aside { max-height:none; } .viewer { min-height:65vh; } header { grid-template-columns:1fr; } .progress-wrap { text-align:left; } }
  </style>
</head>
<body>
  <header>
    <div><h1 id="pageTitle">Photo category labeller</h1><div id="fileInfo" class="muted">Loading analysis…</div></div>
    <div class="progress-wrap"><strong id="progressText">0 / 0 labelled</strong><div class="progress"><div id="progressBar"></div></div></div>
  </header>
  <main>
    <section class="viewer panel">
      <div class="toolbar">
        <select id="filter">
          <option value="unlabelled">Unlabelled photos</option>
          <option value="all">All photos</option>
          <option value="low">Low confidence</option>
          <option value="menu">Predicted menu</option>
          <option value="disagreement">Label disagreements</option>
          <option value="ocr-unreviewed">OCR awaiting correction</option>
          <option value="ocr-all">All menu photos with OCR</option>
          <option value="ocr-reviewed">OCR corrections completed</option>
        </select>
        <input id="search" type="search" placeholder="Filter restaurant name">
        <span id="filteredCount" class="muted"></span>
      </div>
      <div class="image-stage">
        <span id="loading" class="loading">Loading photo…</span>
        <img id="photo" alt="Photo being labelled">
        <div id="imageError" class="image-error">This image could not be displayed. Try the full-size link or classify it as unknown.</div>
      </div>
      <div class="bottom-nav">
        <button id="previous">← Previous</button>
        <span id="position" class="muted"></span>
        <div><button id="skip">Skip</button> <button id="next">Next →</button></div>
      </div>
    </section>
    <aside class="panel">
      <h2 id="restaurant" class="restaurant"></h2>
      <div id="meta" class="meta"></div>
      <div id="chips" class="chips"></div>
      <div class="model-box">
        <strong>Model prediction: <span id="prediction"></span></strong>
        <div id="scores" class="scores"></div>
      </div>
      <div id="categoryPrompt"><strong>Choose the actual category</strong></div>
      <div id="categoryButtons" class="labels">
        <button class="label menu" data-category="menu">1 · Menu</button>
        <button class="label food" data-category="food">2 · Food</button>
        <button class="label interior" data-category="interior">3 · Interior</button>
        <button class="label unknown" data-category="unknown">4 · Unknown</button>
      </div>
      <div class="ocr-head"><strong>Expected menu text (optional)</strong><span id="ocrMeta" class="muted"></span></div>
      <textarea id="expectedOcr" placeholder="Correct the OCR here only if you want OCR character accuracy."></textarea>
      <div class="ocr-head"><span class="muted">Extracted OCR text</span><button id="copyOcr">Copy to expected</button></div>
      <div id="ocrText" class="ocr-source">No OCR text</div>
      <div id="status" class="status"></div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px">
        <button id="saveText">Save category and OCR text</button>
        <button id="clearLabel">Clear label</button>
        <a id="fullSize" class="link-button" target="_blank" rel="noreferrer">Open full size</a>
        <a href="/api/export" class="link-button">Download labels CSV</a>
      </div>
      <div id="shortcuts" class="shortcuts">Keyboard: 1 Menu · 2 Food · 3 Interior · 4 Unknown · ← Previous · → Next · S Skip. Every category choice autosaves.</div>
    </aside>
  </main>
  <script>
    const state = { all: [], filtered: [], index: 0, total: 0, labelled: 0, mode: 'classification', ocrEligible: 0, ocrReviewed: 0, ocrMeanCharacterAccuracy: null, saving: false };
    const elements = Object.fromEntries(['pageTitle','fileInfo','progressText','progressBar','filter','search','filteredCount','loading','photo','imageError','previous','skip','next','position','restaurant','meta','chips','prediction','scores','categoryPrompt','categoryButtons','expectedOcr','ocrMeta','ocrText','status','saveText','clearLabel','fullSize','copyOcr','shortcuts'].map(id => [id, document.getElementById(id)]));

    init().catch(error => setStatus(error.message, true));

    async function init() {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error('Could not load labelling data.');
      const data = await response.json();
      state.all = data.records;
      state.total = data.total;
      state.labelled = data.labelled;
      state.mode = data.mode;
      state.ocrEligible = data.ocrEligible;
      state.ocrReviewed = data.ocrReviewed;
      state.ocrMeanCharacterAccuracy = data.ocrMeanCharacterAccuracy;
      if (state.mode === 'ocr') {
        elements.pageTitle.textContent = 'OCR character accuracy reviewer';
        elements.filter.value = 'ocr-unreviewed';
        elements.categoryPrompt.style.display = 'none';
        elements.categoryButtons.style.display = 'none';
        elements.clearLabel.style.display = 'none';
        elements.saveText.textContent = 'Save corrected OCR text';
        elements.shortcuts.textContent = 'Correct the extracted text exactly as shown in the photo, save, then use ← and → to navigate. S skips the current photo.';
      }
      elements.fileInfo.textContent = data.inputFile + ' · autosaves to ' + data.labelsFile;
      updateProgress();
      applyFilter(true);
    }

    function applyFilter(jumpToFirstUnlabelled = false) {
      const filter = elements.filter.value;
      const search = elements.search.value.trim().toLowerCase();
      state.filtered = state.all.filter(record => {
        if (search && !record.restaurantName.toLowerCase().includes(search)) return false;
        if (filter === 'unlabelled') return !record.actualCategory;
        if (filter === 'low') return record.confidenceLevel === 'low';
        if (filter === 'menu') return record.predictedCategory === 'menu';
        if (filter === 'disagreement') return record.actualCategory && record.actualCategory !== record.predictedCategory;
        if (filter === 'ocr-unreviewed') return record.actualCategory === 'menu' && record.ocrText && !record.expectedOcrText;
        if (filter === 'ocr-all') return record.actualCategory === 'menu' && record.ocrText;
        if (filter === 'ocr-reviewed') return record.actualCategory === 'menu' && record.ocrText && record.expectedOcrText;
        return true;
      });
      if (jumpToFirstUnlabelled) {
        const first = state.filtered.findIndex(record => state.mode === 'ocr'
          ? !record.expectedOcrText
          : !record.actualCategory);
        state.index = first >= 0 ? first : 0;
      } else {
        state.index = Math.min(state.index, Math.max(0, state.filtered.length - 1));
      }
      render();
    }

    function render() {
      elements.filteredCount.textContent = state.filtered.length + ' shown';
      const record = current();
      if (!record) {
        elements.photo.removeAttribute('src');
        elements.loading.style.display = 'none';
        elements.imageError.style.display = 'block';
        elements.imageError.textContent = state.all.length ? 'No photos match this filter.' : 'No photos are available.';
        elements.restaurant.textContent = 'Nothing to label';
        elements.position.textContent = '';
        setControlsDisabled(true);
        return;
      }
      setControlsDisabled(false);
      elements.loading.style.display = 'block';
      elements.imageError.style.display = 'none';
      elements.photo.style.display = 'block';
      elements.photo.src = record.imageUrl;
      elements.restaurant.textContent = record.restaurantName;
      elements.meta.textContent = (record.area || 'Area unavailable') + ' · restaurant photo ' + record.restaurantPhotoIndex;
      elements.position.textContent = (state.index + 1) + ' / ' + state.filtered.length + ' shown · photo ' + record.sequence + ' / ' + state.total;
      elements.prediction.textContent = (record.predictedCategory || 'none') + ' (' + percent(record.confidence) + ')';
      elements.fullSize.href = record.fullSizeImageUrl;
      elements.expectedOcr.value = record.expectedOcrText || '';
      elements.ocrText.textContent = record.ocrText || 'No OCR text';
      elements.ocrMeta.textContent = record.ocrStatus
        ? [
            record.ocrEngine || 'OCR',
            record.ocrStatus,
            record.ocrConfidence == null ? null : Math.round(record.ocrConfidence) + '% confidence',
            record.ocrPriceCandidateCount == null ? null : record.ocrPriceCandidateCount + ' price candidates',
            record.ocrElapsedSeconds == null ? null : record.ocrElapsedSeconds + 's',
          ].filter(Boolean).join(' · ')
        : 'not attempted';
      elements.chips.replaceChildren(...[
        record.actualCategory ? 'Saved: ' + record.actualCategory : 'Unlabelled',
        'Confidence: ' + (record.confidenceLevel || 'n.a.'),
        record.sourceTabs.length ? 'Tabs: ' + record.sourceTabs.join(', ') : 'No source tab',
        record.originalWidth && record.originalHeight ? record.originalWidth + '×' + record.originalHeight : null,
      ].filter(Boolean).map(chip));
      elements.scores.replaceChildren(...Object.entries(record.categoryScores || {}).flatMap(([name,value]) => {
        const key = document.createElement('span'); key.textContent = name;
        const score = document.createElement('span'); score.textContent = percent(value);
        return [key, score];
      }));
      document.querySelectorAll('.label').forEach(button => button.classList.toggle('selected', button.dataset.category === record.actualCategory));
      elements.previous.disabled = state.index === 0;
      elements.next.disabled = state.index >= state.filtered.length - 1;
      elements.clearLabel.disabled = !record.actualCategory;
      setStatus(record.actualCategory ? 'Saved as ' + record.actualCategory : 'Choose a category to autosave.');
      preloadNext();
    }

    async function save(category, advance = true) {
      const record = current();
      if (!record || state.saving) return;
      state.saving = true;
      setStatus('Saving…');
      try {
        const response = await fetch('/api/label', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ photoId: record.photoId, actualCategory: category, expectedOcrText: elements.expectedOcr.value }),
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Save failed.');
        const wasUnlabelled = !record.actualCategory;
        record.actualCategory = category;
        record.expectedOcrText = elements.expectedOcr.value.trim();
        if (wasUnlabelled) state.labelled = result.labelled;
        if (result.ocrEvaluation) {
          state.ocrEligible = result.ocrEvaluation.eligibleImages;
          state.ocrReviewed = result.ocrEvaluation.labelledImages;
          state.ocrMeanCharacterAccuracy = result.ocrEvaluation.meanCharacterAccuracy;
        }
        updateProgress();
        if (advance) advanceAfterSave(record.photoId);
        else render();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        state.saving = false;
      }
    }

    function advanceAfterSave(photoId) {
      if (elements.filter.value === 'unlabelled' || elements.filter.value === 'ocr-unreviewed') {
        const oldIndex = state.index;
        state.filtered = state.filtered.filter(record => record.photoId !== photoId);
        state.index = Math.min(oldIndex, Math.max(0, state.filtered.length - 1));
      } else {
        state.index = Math.min(state.index + 1, state.filtered.length - 1);
      }
      render();
    }

    async function clearLabel() {
      const record = current();
      if (!record?.actualCategory || state.saving) return;
      state.saving = true;
      try {
        const response = await fetch('/api/label/' + encodeURIComponent(record.photoId), { method: 'DELETE' });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not clear the label.');
        record.actualCategory = null;
        record.expectedOcrText = '';
        state.labelled = result.labelled;
        updateProgress();
        render();
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        state.saving = false;
      }
    }

    function move(amount) {
      if (!state.filtered.length) return;
      state.index = Math.max(0, Math.min(state.filtered.length - 1, state.index + amount));
      render();
    }

    function current() { return state.filtered[state.index] || null; }
    function updateProgress() {
      const completed = state.mode === 'ocr' ? state.ocrReviewed : state.labelled;
      const total = state.mode === 'ocr' ? state.ocrEligible : state.total;
      const percentage = total ? (completed / total) * 100 : 0;
      const accuracy = state.mode === 'ocr' && Number.isFinite(state.ocrMeanCharacterAccuracy)
        ? ' · character accuracy ' + (state.ocrMeanCharacterAccuracy * 100).toFixed(1) + '%'
        : '';
      elements.progressText.textContent = completed + ' / ' + total + (state.mode === 'ocr' ? ' OCR reviewed (' : ' labelled (') + percentage.toFixed(1) + '%)' + accuracy;
      elements.progressBar.style.width = percentage + '%';
    }
    function percent(value) { return Number.isFinite(value) ? Math.round(value * 1000) / 10 + '%' : 'n.a.'; }
    function chip(text) { const span = document.createElement('span'); span.className = 'chip'; span.textContent = text; return span; }
    function setStatus(message, error = false) { elements.status.textContent = message; elements.status.style.color = error ? '#ffb4ab' : '#65d6a8'; }
    function setControlsDisabled(disabled) { document.querySelectorAll('button.label,#saveText,#clearLabel,#skip,#next,#previous').forEach(button => { button.disabled = disabled; }); }
    function preloadNext() { const next = state.filtered[state.index + 1]; if (next) { const image = new Image(); image.src = next.imageUrl; } }

    elements.photo.addEventListener('load', () => { elements.loading.style.display = 'none'; elements.imageError.style.display = 'none'; });
    elements.photo.addEventListener('error', () => { elements.loading.style.display = 'none'; elements.photo.style.display = 'none'; elements.imageError.style.display = 'block'; });
    elements.filter.addEventListener('change', () => applyFilter(true));
    elements.search.addEventListener('input', () => applyFilter(true));
    elements.previous.addEventListener('click', () => move(-1));
    elements.next.addEventListener('click', () => move(1));
    elements.skip.addEventListener('click', () => move(1));
    elements.clearLabel.addEventListener('click', clearLabel);
    elements.saveText.addEventListener('click', () => { const record = current(); if (record?.actualCategory) save(record.actualCategory, false); else setStatus('Choose a category before saving OCR text.', true); });
    elements.copyOcr.addEventListener('click', () => { elements.expectedOcr.value = current()?.ocrText || ''; });
    document.querySelectorAll('.label').forEach(button => button.addEventListener('click', () => save(button.dataset.category)));
    document.addEventListener('keydown', event => {
      if (['TEXTAREA','INPUT','SELECT'].includes(document.activeElement?.tagName)) return;
      if (event.key >= '1' && event.key <= '4') { event.preventDefault(); save(['menu','food','interior','unknown'][Number(event.key) - 1]); }
      else if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      else if (event.key === 'ArrowRight' || event.key.toLowerCase() === 's') { event.preventDefault(); move(1); }
    });
  </script>
</body>
</html>`;
