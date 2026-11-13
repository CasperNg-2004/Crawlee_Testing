// Local-only browser labeller for unpaired structured-menu OCR price evidence.
// It serves only the exact local images referenced by the selected parser run
// and atomically saves human verification to a JSON file under config/.

import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { basename, dirname, extname, join, resolve } from 'node:path';

const CATEGORIES = [
  'item_price',
  'price_variant',
  'addon_price',
  'bundle_price',
  'not_a_price',
  'duplicate',
  'unreadable',
  'unknown',
];
const ACTIONABLE_CATEGORIES = new Set([
  'item_price', 'price_variant', 'addon_price', 'bundle_price',
]);
const host = '127.0.0.1';
const port = positiveInteger(process.env.MENU_OCR_LABEL_PORT, 3792);
const outputRoot = resolve(process.env.MENU_OCR_PARSER_OUTPUT_DIR?.trim() || 'output/menu-ocr-parsing');
const explicitInput = process.env.MENU_OCR_LABEL_INPUT?.trim();
const labelsPath = resolve(
  process.env.MENU_OCR_UNPAIRED_LABELS?.trim() || 'config/menu-ocr-unpaired-labels.json',
);
const shouldOpenBrowser = booleanValue(process.env.MENU_OCR_LABEL_OPEN_BROWSER, true);

const inputPath = explicitInput
  ? await resolveInput(explicitInput)
  : await findLatestStructuredMenu(outputRoot);
if (!inputPath) throw new Error(`No structured-menu.json was found under ${outputRoot}.`);

const report = JSON.parse(await readFile(inputPath, 'utf8'));
const records = await flattenUnpairedRecords(report);
if (!records.length) throw new Error(`${inputPath} contains no unpaired price records.`);
const recordByKey = new Map(records.map((record) => [record.key, record]));
const loaded = await loadLabels(labelsPath);
const labels = new Map(loaded.map((label) => [label.key, label]));
let saveQueue = Promise.resolve();

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    if (request.method === 'GET' && url.pathname === '/') {
      return send(response, 200, HTML, 'text/html; charset=utf-8');
    }
    if (request.method === 'GET' && url.pathname === '/api/health') {
      return sendJson(response, 200, {
        status: 'ok',
        records: records.length,
        labelled: currentLabelCount(),
      });
    }
    if (request.method === 'GET' && url.pathname === '/api/state') {
      return sendJson(response, 200, buildState());
    }
    if (request.method === 'GET' && url.pathname.startsWith('/api/image/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/image/'.length));
      const record = recordByKey.get(key);
      if (!record) return sendJson(response, 404, { error: 'Unpaired record was not found.' });
      const image = await readFile(record.imagePath);
      return send(response, 200, image, imageContentType(record.imagePath));
    }
    if (request.method === 'GET' && url.pathname === '/api/export') {
      const body = `${JSON.stringify(buildLabelsDocument(), null, 2)}\n`;
      response.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${basename(labelsPath)}"`,
        'Cache-Control': 'no-store',
      });
      return response.end(body);
    }
    if (request.method === 'POST' && url.pathname === '/api/label') {
      const body = await readJsonBody(request);
      const key = String(body.key || '').trim();
      const record = recordByKey.get(key);
      if (!record) return sendJson(response, 404, { error: 'Unpaired record was not found.' });
      const category = String(body.category || '').trim().toLowerCase();
      if (!CATEGORIES.includes(category)) {
        return sendJson(response, 400, { error: `Category must be one of: ${CATEGORIES.join(', ')}.` });
      }
      const itemName = cleanText(body.itemName);
      const priceText = cleanText(body.priceText);
      const priceValue = nullableNumber(body.priceValue);
      const variantLabel = cleanText(body.variantLabel);
      if (ACTIONABLE_CATEGORIES.has(category)) {
        if (!itemName) return sendJson(response, 400, { error: 'Verified menu prices require an item name.' });
        if (!priceText) return sendJson(response, 400, { error: 'Verified menu prices require the displayed price text.' });
        if (priceValue == null) return sendJson(response, 400, { error: 'Verified menu prices require a numeric price value.' });
        if (category === 'price_variant' && !variantLabel) {
          return sendJson(response, 400, { error: 'A price variant requires a label such as Hot, Iced, Small, or Large.' });
        }
      }
      labels.set(key, {
        key,
        fileName: record.fileName,
        lineIndex: record.lineIndex,
        category,
        section: cleanText(body.section),
        itemName,
        description: cleanText(body.description),
        priceText,
        priceValue,
        currency: normalizeCurrency(body.currency),
        variantLabel,
        notes: cleanText(body.notes),
        sourceLineText: record.lineText,
        sourceBox: record.box,
        reviewedAt: new Date().toISOString(),
      });
      await queueSave();
      return sendJson(response, 200, {
        ok: true,
        labelled: currentLabelCount(),
        total: records.length,
      });
    }
    if (request.method === 'DELETE' && url.pathname.startsWith('/api/label/')) {
      const key = decodeURIComponent(url.pathname.slice('/api/label/'.length));
      if (!recordByKey.has(key)) return sendJson(response, 404, { error: 'Unpaired record was not found.' });
      labels.delete(key);
      await queueSave();
      return sendJson(response, 200, {
        ok: true,
        labelled: currentLabelCount(),
        total: records.length,
      });
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
  console.log(`Menu OCR unpaired labeller ready: ${url}`);
  console.log(`Input: ${inputPath}`);
  console.log(`Unpaired price lines: ${records.length}; already labelled: ${currentLabelCount()}`);
  console.log(`Autosave: ${labelsPath}`);
  console.log('Press Ctrl+C to stop. Saved labels are preserved.');
  if (shouldOpenBrowser) openBrowser(url);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log('\nStopping menu OCR labeller. Waiting for the latest save...');
    await saveQueue.catch(() => {});
    server.close(() => process.exit(0));
  });
}

function buildState() {
  return {
    inputFile: inputPath,
    labelsFile: labelsPath,
    categories: CATEGORIES,
    actionableCategories: [...ACTIONABLE_CATEGORIES],
    total: records.length,
    labelled: currentLabelCount(),
    records: records.map((record) => ({
      ...record,
      imagePath: undefined,
      imageUrl: `/api/image/${encodeURIComponent(record.key)}`,
      label: labels.get(record.key) || null,
    })),
  };
}

async function flattenUnpairedRecords(value) {
  const flattened = [];
  for (const image of value.images || []) {
    const imagePath = image.inputPath ? resolve(image.inputPath) : null;
    const imageAvailable = imagePath ? await fileExists(imagePath) : false;
    for (const row of image.unpairedPrices || []) {
      const lineIndex = Number(row.lineIndex);
      if (!Number.isInteger(lineIndex)) continue;
      const key = `${image.fileName}::${lineIndex}`;
      const firstPrice = Array.isArray(row.prices) && row.prices.length === 1
        ? row.prices[0]
        : null;
      flattened.push({
        sequence: flattened.length + 1,
        key,
        fileName: image.fileName,
        lineIndex,
        lineText: row.lineText || null,
        box: Array.isArray(row.box) ? row.box : null,
        reason: row.reason || null,
        prices: Array.isArray(row.prices) ? row.prices : [],
        suggestedNames: (row.candidateNames || [])
          .map((candidate) => ({
            text: candidate.text || null,
            score: numberOrNull(candidate.score),
            pairingMethod: candidate.pairingMethod || null,
          }))
          .filter((candidate) => candidate.text),
        defaultPriceText: firstPrice?.priceText || row.lineText || '',
        defaultPriceValue: numberOrNull(firstPrice?.priceValue),
        defaultCurrency: firstPrice?.currency || null,
        imageAvailable,
        imagePath,
      });
    }
  }
  return flattened;
}

function currentLabelCount() {
  return records.filter((record) => labels.has(record.key)).length;
}

async function queueSave() {
  const task = saveQueue.catch(() => {}).then(async () => {
    await mkdir(dirname(labelsPath), { recursive: true });
    await writeLabelsWithRetry(`${JSON.stringify(buildLabelsDocument(), null, 2)}\n`);
  });
  saveQueue = task.catch(() => {});
  return task;
}

function buildLabelsDocument() {
  return {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    sourceParserOutput: inputPath,
    categories: CATEGORIES,
    labels: [...labels.values()].sort((left, right) => left.key.localeCompare(right.key)),
  };
}

async function writeLabelsWithRetry(contents) {
  const temporaryPath = `${labelsPath}.${process.pid}.tmp`;
  let lastError = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await writeFile(temporaryPath, contents, 'utf8');
      await rename(temporaryPath, labelsPath);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!isRetryableFileError(error) || attempt === 10) break;
      await sleep(Math.min(150 * attempt, 1_000));
    }
  }
  throw new Error(`Could not save ${basename(labelsPath)}: ${conciseError(lastError)}`);
}

async function loadLabels(path) {
  if (!await fileExists(path)) return [];
  const parsed = JSON.parse(await readFile(path, 'utf8'));
  const rows = Array.isArray(parsed) ? parsed : parsed.labels;
  return Array.isArray(rows)
    ? rows.filter((row) => row && typeof row.key === 'string')
    : [];
}

async function resolveInput(value) {
  const path = resolve(value);
  const info = await stat(path);
  return info.isDirectory() ? join(path, 'structured-menu.json') : path;
}

async function findLatestStructuredMenu(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name, 'structured-menu.json');
    if (!await fileExists(candidate)) continue;
    const details = await stat(candidate);
    candidates.push({ path: candidate, modified: details.mtimeMs });
  }
  candidates.sort((left, right) => right.modified - left.modified);
  return candidates[0]?.path || null;
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

function imageContentType(path) {
  return ({
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
  })[extname(path).toLowerCase()] || 'application/octet-stream';
}

function normalizeCurrency(value) {
  const currency = cleanText(value)?.toUpperCase();
  return currency || null;
}

function cleanText(value) {
  const text = String(value ?? '').replace(/\r/g, '').trim();
  return text || null;
}

function nullableNumber(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function booleanValue(value, fallback) {
  if (value == null || !String(value).trim()) return fallback;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function isRetryableFileError(error) {
  return ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(error?.code);
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

const HTML = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Unpaired menu price labeller</title>
  <style>
    :root{color-scheme:dark;--bg:#07111f;--panel:#101d30;--line:#2a3b56;--text:#eff6ff;--muted:#9db0ca;--accent:#5ee2b8;--warn:#ffd166}
    *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.4 Inter,Segoe UI,Arial,sans-serif}button,input,textarea,select{font:inherit}
    header{position:sticky;top:0;z-index:10;display:grid;grid-template-columns:1fr auto;gap:18px;padding:13px 18px;background:#091628f2;border-bottom:1px solid var(--line);backdrop-filter:blur(8px)}h1{font-size:18px;margin:0}.muted{color:var(--muted)}
    .progress{text-align:right;min-width:280px}.bar{height:7px;margin-top:7px;background:#263650;border-radius:9px;overflow:hidden}.bar>div{height:100%;background:linear-gradient(90deg,#24a4ff,var(--accent));width:0}
    main{display:grid;grid-template-columns:minmax(0,1fr) 430px;gap:14px;padding:14px}.panel{background:var(--panel);border:1px solid var(--line);border-radius:13px;overflow:hidden}
    .toolbar,.nav{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line);flex-wrap:wrap}.nav{border-top:1px solid var(--line);border-bottom:0;justify-content:space-between}
    select,input,textarea{width:100%;color:var(--text);background:#0b1728;border:1px solid #3a4c68;border-radius:8px;padding:8px 9px}select{width:auto}.search{width:240px}
    .stage{min-height:calc(100vh - 180px);display:flex;align-items:center;justify-content:center;padding:14px;background:#030810;overflow:auto}.image-wrap{position:relative;display:inline-block;line-height:0}.image-wrap img{display:block;max-width:100%;max-height:calc(100vh - 225px);object-fit:contain}.highlight{position:absolute;border:4px solid #ff4d6d;background:#ff4d6d28;box-shadow:0 0 0 2px #fff8,0 0 22px #ff4d6dcc;pointer-events:none}
    aside{padding:15px;max-height:calc(100vh - 90px);overflow:auto}.title{font-size:19px;margin:0 0 3px}.source{padding:10px;margin:10px 0;background:#07111f;border:1px solid var(--line);border-radius:9px}.source strong{font-size:18px;color:var(--warn)}
    .chips{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}.chip{border:1px solid #425675;border-radius:999px;padding:5px 8px;background:#182840;color:#d9e8ff;cursor:pointer}.categories{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.category{padding:10px 7px;font-weight:700}.category.selected{outline:3px solid white;outline-offset:1px}.positive{background:#12644f}.neutral{background:#3d4c64}.negative{background:#713b45}
    .fields{display:grid;grid-template-columns:1fr 1fr;gap:9px}.wide{grid-column:1/-1}label{display:block;color:var(--muted);font-size:12px}label input,label textarea,label select{margin-top:4px;color:var(--text)}textarea{min-height:72px;resize:vertical}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}button,.link{border:1px solid #435979;border-radius:8px;padding:8px 11px;background:#1a2d49;color:var(--text);cursor:pointer;text-decoration:none}.primary{background:#12644f;border-color:#2fc39b}.status{min-height:22px;margin-top:9px;color:var(--accent)}
    @media(max-width:980px){main{grid-template-columns:1fr}aside{max-height:none}.stage{min-height:60vh}header{grid-template-columns:1fr}.progress{text-align:left}}
  </style>
</head>
<body>
  <header><div><h1>Unpaired menu price labeller</h1><div id="fileInfo" class="muted">Loading…</div></div><div class="progress"><strong id="progressText">0 / 0 reviewed</strong><div class="bar"><div id="progressBar"></div></div></div></header>
  <main>
    <section class="panel">
      <div class="toolbar"><select id="filter"><option value="unlabelled">Unreviewed</option><option value="all">All evidence</option></select><input id="search" class="search" type="search" placeholder="Filter image or OCR text"><span id="shown" class="muted"></span></div>
      <div class="stage"><div class="image-wrap"><img id="photo" alt="Menu photo"><div id="highlight" class="highlight"></div></div></div>
      <div class="nav"><button id="previous">← Previous</button><span id="position" class="muted"></span><div><button id="skip">Skip</button> <button id="next">Next →</button></div></div>
    </section>
    <aside class="panel">
      <h2 id="fileName" class="title"></h2><div id="lineMeta" class="muted"></div>
      <div class="source"><div class="muted">OCR line</div><strong id="lineText"></strong><div id="reason" class="muted"></div></div>
      <div class="muted">Suggested nearby names</div><div id="suggestions" class="chips"></div>
      <div id="categories" class="categories"></div>
      <div class="fields">
        <label>Section<input id="section"></label><label>Item name<input id="itemName"></label>
        <label class="wide">Description<textarea id="description"></textarea></label>
        <label>Displayed price<input id="priceText"></label><label>Numeric price<input id="priceValue" type="number" step="0.01"></label>
        <label>Currency<select id="currency"><option value="">Unknown / not shown</option><option>MYR</option><option>USD</option><option>SGD</option></select></label><label>Variant or bundle label<input id="variantLabel" placeholder="Hot, Iced, Glass, 10 bottles…"></label>
        <label class="wide">Notes<textarea id="notes"></textarea></label>
      </div>
      <div class="actions"><button id="save" class="primary">Save and next</button><button id="clear">Clear label</button><a id="openImage" class="link" target="_blank">Open image</a><a class="link" href="/api/export">Download labels</a></div>
      <div id="status" class="status"></div><div class="muted">Keys 1–8 select categories · Ctrl+Enter saves · ←/→ navigates.</div>
    </aside>
  </main>
  <script>
    const categoryInfo=[['item_price','Item price','positive'],['price_variant','Price variant','positive'],['addon_price','Add-on price','positive'],['bundle_price','Bundle price','positive'],['not_a_price','Not a price','negative'],['duplicate','Duplicate','neutral'],['unreadable','Unreadable','neutral'],['unknown','Unknown','neutral']];
    const state={all:[],filtered:[],index:0,total:0,labelled:0,selectedCategory:null};
    const ids=['fileInfo','progressText','progressBar','filter','search','shown','photo','highlight','previous','skip','next','position','fileName','lineMeta','lineText','reason','suggestions','categories','section','itemName','description','priceText','priceValue','currency','variantLabel','notes','save','clear','openImage','status'];
    const e=Object.fromEntries(ids.map(id=>[id,document.getElementById(id)]));
    init().catch(error=>setStatus(error.message,true));
    async function init(){const response=await fetch('/api/state');const data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load records.');state.all=data.records;state.total=data.total;state.labelled=data.labelled;e.fileInfo.textContent=data.inputFile+' · saving '+data.labelsFile;renderCategoryButtons();applyFilter();}
    function renderCategoryButtons(){e.categories.replaceChildren(...categoryInfo.map(([value,label,tone],index)=>{const button=document.createElement('button');button.className='category '+tone;button.dataset.value=value;button.textContent=(index+1)+' · '+label;button.addEventListener('click',()=>selectCategory(value));return button;}));}
    function applyFilter(reset=true){const query=e.search.value.trim().toLowerCase();state.filtered=state.all.filter(record=>(e.filter.value==='all'||!record.label)&&(!query||record.fileName.toLowerCase().includes(query)||(record.lineText||'').toLowerCase().includes(query)));if(reset)state.index=0;if(state.index>=state.filtered.length)state.index=Math.max(0,state.filtered.length-1);render();}
    function current(){return state.filtered[state.index]||null;}
    function render(){const record=current();state.labelled=state.all.filter(row=>row.label).length;e.progressText.textContent=state.labelled+' / '+state.total+' reviewed';e.progressBar.style.width=(state.total?state.labelled/state.total*100:0)+'%';e.shown.textContent=state.filtered.length+' shown';if(!record){e.fileName.textContent='Nothing to review';e.photo.removeAttribute('src');e.highlight.style.display='none';return;}e.position.textContent=(state.index+1)+' / '+state.filtered.length;e.fileName.textContent=record.fileName;e.lineMeta.textContent='Line '+record.lineIndex+' · '+(record.reason||'unpaired');e.lineText.textContent=record.lineText||'(empty OCR line)';e.reason.textContent=(record.prices||[]).map(price=>[price.priceText,price.priceValue,price.currency].filter(value=>value!=null).join(' · ')).join(' | ');e.suggestions.replaceChildren(...record.suggestedNames.map(candidate=>{const button=document.createElement('button');button.className='chip';button.textContent=candidate.text+' '+Math.round((candidate.score||0)*100)+'%';button.addEventListener('click',()=>{e.itemName.value=candidate.text;});return button;}));const label=record.label||{};state.selectedCategory=label.category||null;e.section.value=label.section||'';e.itemName.value=label.itemName||record.suggestedNames[0]?.text||'';e.description.value=label.description||'';e.priceText.value=label.priceText??record.defaultPriceText??'';e.priceValue.value=label.priceValue??record.defaultPriceValue??'';e.currency.value=label.currency||record.defaultCurrency||'';e.variantLabel.value=label.variantLabel||'';e.notes.value=label.notes||'';updateCategoryButtons();e.openImage.href=record.imageUrl;e.photo.onload=()=>drawBox(record);e.photo.src=record.imageUrl;setStatus('');}
    function drawBox(record){if(!record.box||record.box.length<4){e.highlight.style.display='none';return;}const [x1,y1,x2,y2]=record.box;const width=e.photo.naturalWidth||1;const height=e.photo.naturalHeight||1;e.highlight.style.display='block';e.highlight.style.left=(x1/width*100)+'%';e.highlight.style.top=(y1/height*100)+'%';e.highlight.style.width=((x2-x1)/width*100)+'%';e.highlight.style.height=((y2-y1)/height*100)+'%';}
    function selectCategory(value){state.selectedCategory=value;updateCategoryButtons();}
    function updateCategoryButtons(){document.querySelectorAll('.category').forEach(button=>button.classList.toggle('selected',button.dataset.value===state.selectedCategory));}
    async function save(){const record=current();if(!record)return;if(!state.selectedCategory){setStatus('Choose a category first.',true);return;}const payload={key:record.key,category:state.selectedCategory,section:e.section.value,itemName:e.itemName.value,description:e.description.value,priceText:e.priceText.value,priceValue:e.priceValue.value,currency:e.currency.value,variantLabel:e.variantLabel.value,notes:e.notes.value};setStatus('Saving…');const response=await fetch('/api/label',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});const result=await response.json();if(!response.ok){setStatus(result.error||'Save failed.',true);return;}record.label={...payload,priceValue:payload.priceValue===''?null:Number(payload.priceValue)};state.labelled=result.labelled;setStatus('Saved.');applyFilter(false);if(e.filter.value==='all')move(1);}
    async function clearLabel(){const record=current();if(!record?.label)return;const response=await fetch('/api/label/'+encodeURIComponent(record.key),{method:'DELETE'});const result=await response.json();if(!response.ok){setStatus(result.error||'Clear failed.',true);return;}record.label=null;state.labelled=result.labelled;state.selectedCategory=null;applyFilter(false);}
    function move(delta){if(!state.filtered.length)return;state.index=Math.min(Math.max(state.index+delta,0),state.filtered.length-1);render();}
    function setStatus(message,isError=false){e.status.textContent=message;e.status.style.color=isError?'#ff9b9b':'var(--accent)';}
    e.filter.addEventListener('change',()=>applyFilter());e.search.addEventListener('input',()=>applyFilter());e.previous.addEventListener('click',()=>move(-1));e.next.addEventListener('click',()=>move(1));e.skip.addEventListener('click',()=>move(1));e.save.addEventListener('click',save);e.clear.addEventListener('click',clearLabel);window.addEventListener('resize',()=>{const record=current();if(record&&e.photo.complete)drawBox(record);});document.addEventListener('keydown',event=>{if(event.ctrlKey&&event.key==='Enter'){event.preventDefault();save();return;}if(['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))return;if(event.key>='1'&&event.key<='8'){event.preventDefault();selectCategory(categoryInfo[Number(event.key)-1][0]);}else if(event.key==='ArrowLeft'){event.preventDefault();move(-1);}else if(event.key==='ArrowRight'){event.preventDefault();move(1);}});
  </script>
</body>
</html>`;
