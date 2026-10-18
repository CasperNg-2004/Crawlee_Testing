// Local browser interface for manually validating photo categories.
// It reads the latest independent photo-analysis output and writes labels to
// config/photo-analysis-labels.csv, which analyze-photos.js already uses.

import { access, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const CATEGORIES = ['menu', 'food', 'interior', 'unknown'];
const host = '127.0.0.1';
const port = positiveInteger(process.env.PHOTO_LABEL_PORT, 3789);
const outputRoot = resolve(process.env.PHOTO_ANALYSIS_OUTPUT_DIR?.trim() || 'output/photo-analysis');
const explicitInput = process.env.PHOTO_LABEL_INPUT?.trim();
const labelsPath = resolve(process.env.PHOTO_ANALYSIS_LABELS?.trim() || 'config/photo-analysis-labels.csv');
const shouldOpenBrowser = booleanValue(process.env.PHOTO_LABEL_OPEN_BROWSER, true);

const inputPath = explicitInput
  ? resolve(explicitInput)
  : await findLatestCompletedAnalysis(outputRoot);
if (!inputPath) throw new Error(`No completed photo-analysis.json was found under ${outputRoot}.`);

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
      return sendJson(response, 200, { ok: true, labelled: labels.size, total: records.length });
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
  console.log(`Photo labeller ready: ${url}`);
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
  return {
    inputFile: basename(inputPath),
    labelsFile: basename(labelsPath),
    categories: CATEGORIES,
    total: records.length,
    labelled: labels.size,
    records: records.map((record) => ({
      ...record,
      actualCategory: labels.get(record.photoId)?.actualCategory || null,
      expectedOcrText: labels.get(record.photoId)?.expectedOcrText || '',
    })),
  };
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
        ocrStatus: image.ocr?.status || null,
        ocrConfidence: numberOrNull(image.ocr?.confidence),
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
  const temporaryPath = `${labelsPath}.${process.pid}.tmp`;
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await writeFile(temporaryPath, csv, 'utf8');
      await rename(temporaryPath, labelsPath);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!isRetryableFileError(error) || attempt === 10) break;
      await sleep(Math.min(150 * attempt, 1_000));
    }
  }
  throw new Error(
    `Could not save labels after 10 attempts. Close ${basename(labelsPath)} if it is open in Excel, then choose the category again. ${conciseError(lastError)}`,
  );
}

function isRetryableFileError(error) {
  return ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(error?.code);
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

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(cell);
      cell = '';
    } else if (character === '\n') {
      row.push(cell.replace(/\r$/, ''));
      if (row.some((value) => value.length)) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += character;
    }
  }
  if (cell.length || row.length) {
    row.push(cell);
    rows.push(row);
  }
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) => Object.fromEntries(
    headers.map((header, index) => [header, values[index] || '']),
  ));
}

async function findLatestCompletedAnalysis(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((left, right) => basename(right).localeCompare(basename(left)));
  for (const directory of directories) {
    const candidate = join(directory, 'photo-analysis.json');
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function sendJson(response, status, value) {
  return send(response, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8');
}

function send(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

function openBrowser(url) {
  try {
    const command = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      : process.platform === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    command.unref();
  } catch (error) {
    console.warn(`Could not open the browser automatically: ${conciseError(error)}`);
  }
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function cleanText(value) {
  return String(value || '').replace(/\r/g, '').trim();
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback) {
  if (value == null || !String(value).trim()) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function conciseError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function fileExists(path) {
  return access(path).then(() => true).catch(() => false);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
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
    <div><h1>Photo category labeller</h1><div id="fileInfo" class="muted">Loading analysis…</div></div>
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
      <strong>Choose the actual category</strong>
      <div class="labels">
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
      <div class="shortcuts">Keyboard: 1 Menu · 2 Food · 3 Interior · 4 Unknown · ← Previous · → Next · S Skip. Every category choice autosaves.</div>
    </aside>
  </main>
  <script>
    const state = { all: [], filtered: [], index: 0, total: 0, labelled: 0, saving: false };
    const elements = Object.fromEntries(['fileInfo','progressText','progressBar','filter','search','filteredCount','loading','photo','imageError','previous','skip','next','position','restaurant','meta','chips','prediction','scores','expectedOcr','ocrMeta','ocrText','status','saveText','clearLabel','fullSize','copyOcr'].map(id => [id, document.getElementById(id)]));

    init().catch(error => setStatus(error.message, true));

    async function init() {
      const response = await fetch('/api/state');
      if (!response.ok) throw new Error('Could not load labelling data.');
      const data = await response.json();
      state.all = data.records;
      state.total = data.total;
      state.labelled = data.labelled;
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
        return true;
      });
      if (jumpToFirstUnlabelled) {
        const first = state.filtered.findIndex(record => !record.actualCategory);
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
      elements.ocrMeta.textContent = record.ocrStatus ? record.ocrStatus + (record.ocrConfidence == null ? '' : ' · ' + Math.round(record.ocrConfidence) + '%') : 'not attempted';
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
      if (elements.filter.value === 'unlabelled') {
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
      const percentage = state.total ? (state.labelled / state.total) * 100 : 0;
      elements.progressText.textContent = state.labelled + ' / ' + state.total + ' labelled (' + percentage.toFixed(1) + '%)';
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
