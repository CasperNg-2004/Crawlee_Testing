// Independent photo analyzer for the Google Maps photo metadata already saved
// in output/restaurants.json. This file does not launch or modify the scraper.
//
// Run a two-place test (default):
//   npm run analyze:photos
// Resume the newest interrupted analysis:
//   npm run analyze:photos:resume
// Recalculate accuracy after filling config/photo-analysis-labels.csv:
//   npm run analyze:photos:evaluate

import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { env, pipeline, RawImage } from '@huggingface/transformers';

const CATEGORIES = ['menu', 'food', 'interior', 'unknown'];
const PROMPTS = {
  menu: [
    'a printed restaurant menu with item names and prices',
    'a cafe menu board containing text and prices',
    'a photographed food or drinks menu page',
  ],
  food: [
    'a close-up photograph of prepared restaurant food',
    'a plated meal, dessert, coffee, or drink',
    'food or beverages served at a cafe',
  ],
  interior: [
    'the inside seating area of a cafe or restaurant',
    'an indoor restaurant dining room with tables and chairs',
    'the interior decor and counter of a cafe',
  ],
  unknown: [
    'the exterior of a building or storefront',
    'people, a logo, a receipt, a screenshot, or an unrelated object',
    'an image that is not a menu, food, drink, or restaurant interior',
  ],
};
const PROMPT_LABELS = Object.values(PROMPTS).flat();
const PROMPT_TO_CATEGORY = new Map(
  Object.entries(PROMPTS).flatMap(([category, prompts]) => prompts.map((prompt) => [prompt, category])),
);

const args = new Set(process.argv.slice(2));
const resume = args.has('--resume');
const evaluateOnly = args.has('--evaluate-only');
const inputPath = resolve(process.env.PHOTO_ANALYSIS_INPUT?.trim() || 'output/restaurants.json');
const outputRoot = resolve(process.env.PHOTO_ANALYSIS_OUTPUT_DIR?.trim() || 'output/photo-analysis');
const labelsPath = resolve(process.env.PHOTO_ANALYSIS_LABELS?.trim() || 'config/photo-analysis-labels.csv');
const modelCacheDir = resolve(process.env.PHOTO_ANALYSIS_MODEL_CACHE?.trim() || '.cache/transformers');
const ocrCacheDir = resolve(process.env.PHOTO_ANALYSIS_OCR_CACHE?.trim() || '.cache/tesseract');
const modelId = process.env.PHOTO_ANALYSIS_MODEL?.trim() || 'Xenova/clip-vit-base-patch32';
const modelDtype = process.env.PHOTO_ANALYSIS_DTYPE?.trim() || 'q8';
const device = process.env.PHOTO_ANALYSIS_DEVICE?.trim() || 'cpu';
const placeLimit = optionalPositiveInteger(process.env.PHOTO_ANALYSIS_PLACE_LIMIT);
const maxPhotosPerPlace = positiveInteger(process.env.PHOTO_ANALYSIS_MAX_PHOTOS_PER_PLACE, 30);
const imageSize = positiveInteger(process.env.PHOTO_ANALYSIS_IMAGE_SIZE, 1280);
const requestTimeoutMs = positiveInteger(process.env.PHOTO_ANALYSIS_REQUEST_TIMEOUT_MS, 30_000);
const delayMs = nonNegativeInteger(process.env.PHOTO_ANALYSIS_DELAY_MS, 250);
const minimumCategoryScore = decimalBetweenZeroAndOne(process.env.PHOTO_ANALYSIS_MIN_SCORE, 0.42);
const minimumCategoryMargin = decimalBetweenZeroAndOne(process.env.PHOTO_ANALYSIS_MIN_MARGIN, 0.08);
const ocrLanguages = (process.env.PHOTO_ANALYSIS_OCR_LANGUAGES?.trim() || 'eng+msa')
  .split(/[+,|]/)
  .map((language) => language.trim())
  .filter(Boolean);
const requestedPlaceNames = (process.env.PHOTO_ANALYSIS_PLACES?.trim() || '')
  .split('|')
  .map((name) => name.trim().toLowerCase())
  .filter(Boolean);

env.cacheDir = modelCacheDir;
env.allowRemoteModels = true;

await mkdir(outputRoot, { recursive: true });
await mkdir(modelCacheDir, { recursive: true });
await mkdir(ocrCacheDir, { recursive: true });

if (evaluateOnly) {
  await runEvaluationOnly();
  process.exitCode = 0;
} else {
  await runAnalysis();
}

async function runAnalysis() {
  const savedPlaces = JSON.parse(await readFile(inputPath, 'utf8'));
  if (!Array.isArray(savedPlaces)) throw new Error(`${inputPath} must contain a JSON array.`);

  const matchingPlaces = savedPlaces
    .filter((place) => Array.isArray(place?.photos) && place.photos.length)
    .filter((place) => !requestedPlaceNames.length
      || requestedPlaceNames.includes(place.name?.trim().toLowerCase()));
  const selectedPlaces = placeLimit == null ? matchingPlaces : matchingPlaces.slice(0, placeLimit);
  if (!selectedPlaces.length) throw new Error(`No places with photos were found in ${inputPath}.`);

  const resumedRun = resume ? await findLatestIncompleteRun() : null;
  const runRoot = resumedRun || join(outputRoot, timestampForPath(new Date()));
  await mkdir(runRoot, { recursive: true });
  const partialPath = join(runRoot, 'photo-analysis.partial.json');
  const finalPath = join(runRoot, 'photo-analysis.json');
  const startedAt = new Date();
  const report = resumedRun
    ? JSON.parse(await readFile(partialPath, 'utf8'))
    : createEmptyReport(startedAt);
  report.status = 'running';
  report.resumedAt = resumedRun ? startedAt.toISOString() : null;

  const completedKeys = new Set(report.restaurants.map(placeKey));
  const pendingPlaces = selectedPlaces.filter((place) => !completedKeys.has(placeKey(place)));
  console.log(`Photo analysis: ${selectedPlaces.length} restaurant(s), up to ${maxPhotosPerPlace} photos each.`);
  console.log(`Model: ${modelId} (${modelDtype}, ${device}); OCR: ${ocrLanguages.join('+')}.`);
  console.log(`Output: ${runRoot}`);
  if (resumedRun) console.log(`Resuming with ${completedKeys.size} restaurant(s) already complete.`);

  if (!pendingPlaces.length) {
    console.log('No pending restaurants; rebuilding the final report.');
  }

  let classifier = null;
  let ocrWorker = null;
  try {
    if (pendingPlaces.length) {
      console.log('Loading image classification model. The first run downloads and caches its files.');
      classifier = await pipeline('zero-shot-image-classification', modelId, {
        dtype: modelDtype,
        device,
        progress_callback: modelProgressLogger(),
      });
      console.log('Classification model ready.');
    }

    for (const [pendingIndex, place] of pendingPlaces.entries()) {
      const overallIndex = selectedPlaces.findIndex((item) => placeKey(item) === placeKey(place));
      const started = Date.now();
      const photos = place.photos.slice(0, maxPhotosPerPlace);
      console.log(`\n[${overallIndex + 1}/${selectedPlaces.length}] ${place.name}: ${photos.length} photo(s)`);
      const imageResults = [];

      for (const [photoIndex, photo] of photos.entries()) {
        const prefix = `  [${photoIndex + 1}/${photos.length}]`;
        const result = await analyzePhoto(photo, classifier, async () => {
          if (!ocrWorker) {
            console.log('  Starting the reusable OCR worker. Language files are cached after first use.');
            ocrWorker = await createWorker(ocrLanguages.join('+'), 1, {
              cachePath: ocrCacheDir,
              logger: ocrProgressLogger(),
            });
            await ocrWorker.setParameters({ preserve_interword_spaces: '1' });
          }
          return ocrWorker;
        });
        imageResults.push(result);
        const ocrText = result.ocr?.status === 'success'
          ? ` OCR=${Math.round(result.ocr.confidence)}%`
          : '';
        console.log(`${prefix} ${result.analysisStatus}`
          + `${result.category ? ` ${result.category} ${formatPercent(result.confidence)}` : ''}`
          + `${ocrText}${result.error ? ` — ${result.error}` : ''}`);
        if (delayMs && photoIndex < photos.length - 1) await sleep(delayMs);
      }

      const restaurantResult = combineRestaurantResult(place, imageResults, Date.now() - started);
      report.restaurants.push(restaurantResult);
      report.counts = calculateCounts(report.restaurants);
      report.updatedAt = new Date().toISOString();
      await writeJson(partialPath, report);
      console.log(`  Saved checkpoint (${pendingIndex + 1}/${pendingPlaces.length} pending complete).`);
    }
  } finally {
    await ocrWorker?.terminate().catch(() => {});
    await classifier?.dispose?.().catch(() => {});
  }

  report.status = 'complete';
  report.finishedAt = new Date().toISOString();
  report.updatedAt = report.finishedAt;
  report.counts = calculateCounts(report.restaurants);
  const labels = await loadGroundTruth(labelsPath);
  report.evaluation = evaluatePredictions(report.restaurants, labels);
  await writeJson(finalPath, report);
  await writeJson(partialPath, report);
  await writeJson(join(runRoot, 'evaluation.json'), report.evaluation);
  await writeLabelsTemplate(join(runRoot, 'photo-labels-template.csv'), report.restaurants, labels);

  console.log(`\nComplete: ${report.counts.imagesAnalyzed} analyzed, ${report.counts.imagesFailed} failed.`);
  console.log(`Category counts: ${JSON.stringify(report.counts.categories)}.`);
  console.log(`Results: ${finalPath}`);
  console.log(`Validation template: ${join(runRoot, 'photo-labels-template.csv')}`);
  if (report.evaluation.status !== 'evaluated') {
    console.log(`Precision is not available yet: ${report.evaluation.note}`);
  }
}

async function analyzePhoto(photo, classifier, getOcrWorker) {
  const sourceUrl = photo?.fullSizeImageUrl || photo?.sourceImageUrl || null;
  const base = {
    photoId: photo?.photoId ?? null,
    originalFullSizeImageUrl: photo?.fullSizeImageUrl ?? null,
    analysisImageUrl: sourceUrl ? makeResizedGoogleImageUrl(sourceUrl, imageSize) : null,
    originalWidth: numberOrNull(photo?.width),
    originalHeight: numberOrNull(photo?.height),
    sourceTabs: Array.isArray(photo?.tabs) ? photo.tabs : [],
    analysisStatus: 'failed',
    modelTopCategory: null,
    category: null,
    confidence: null,
    confidenceLevel: null,
    margin: null,
    categoryScores: null,
    topPrompt: null,
    classificationReason: null,
    ocr: null,
    error: null,
  };
  if (!sourceUrl) return { ...base, error: 'Photo has no usable image URL.' };

  try {
    const downloaded = await downloadImage(base.analysisImageUrl, requestTimeoutMs);
    const prepared = await sharp(downloaded.buffer, { failOn: 'warning' })
      .rotate()
      .resize({ width: imageSize, height: imageSize, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    const rawImage = await RawImage.read(new Blob([prepared.data], { type: 'image/jpeg' }));
    const predictions = await classifier(rawImage, PROMPT_LABELS);
    const classification = classifyPredictions(predictions);
    const result = {
      ...base,
      analysisStatus: 'success',
      downloadedBytes: downloaded.buffer.length,
      analyzedWidth: prepared.info.width,
      analyzedHeight: prepared.info.height,
      ...classification,
    };

    if (result.category === 'menu') {
      try {
        const ocrInput = await sharp(downloaded.buffer, { failOn: 'warning' })
          .rotate()
          .resize({ width: 1800, height: 1800, fit: 'inside', withoutEnlargement: true })
          .grayscale()
          .normalize()
          .sharpen()
          .png()
          .toBuffer();
        const worker = await getOcrWorker();
        const recognized = await worker.recognize(ocrInput, { rotateAuto: true });
        const text = cleanOcrText(recognized.data.text);
        result.ocr = {
          status: text ? 'success' : 'none',
          languages: ocrLanguages,
          confidence: numberOrNull(recognized.data.confidence),
          text: text || null,
          error: null,
        };
      } catch (error) {
        result.ocr = {
          status: 'failed',
          languages: ocrLanguages,
          confidence: null,
          text: null,
          error: conciseError(error),
        };
      }
    }
    return result;
  } catch (error) {
    return { ...base, error: conciseError(error) };
  }
}

function classifyPredictions(predictions) {
  const categoryScores = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
  for (const prediction of predictions) {
    const category = PROMPT_TO_CATEGORY.get(prediction.label);
    if (category) categoryScores[category] += prediction.score;
  }
  for (const category of CATEGORIES) categoryScores[category] = round(categoryScores[category], 6);
  const ranked = Object.entries(categoryScores).sort((left, right) => right[1] - left[1]);
  const [modelTopCategory, topScore] = ranked[0];
  const margin = round(topScore - ranked[1][1], 6);
  const uncertain = topScore < minimumCategoryScore || margin < minimumCategoryMargin;
  const category = modelTopCategory === 'unknown' || uncertain ? 'unknown' : modelTopCategory;
  const confidenceLevel = confidenceLabel(topScore, margin, uncertain && modelTopCategory !== 'unknown');
  return {
    modelTopCategory,
    category,
    confidence: round(topScore, 6),
    confidenceLevel,
    margin,
    categoryScores,
    topPrompt: predictions[0]?.label ?? null,
    classificationReason: modelTopCategory === 'unknown'
      ? 'model_selected_unknown'
      : uncertain
        ? 'below_score_or_margin_threshold'
        : 'model_selected_category',
  };
}

function combineRestaurantResult(place, images, elapsedMs) {
  const successful = images.filter((image) => image.analysisStatus === 'success');
  const byCategory = Object.fromEntries(CATEGORIES.map((category) => [
    category,
    successful.filter((image) => image.category === category),
  ]));
  const menuTexts = byCategory.menu
    .filter((image) => image.ocr?.text)
    .map((image) => ({
      photoId: image.photoId,
      confidence: image.ocr.confidence,
      text: image.ocr.text,
    }));
  return {
    name: place.name ?? null,
    area: place.area ?? null,
    googleMapsUrl: place.googleMapsUrl ?? null,
    status: images.some((image) => image.analysisStatus === 'success')
      ? images.some((image) => image.analysisStatus === 'failed') ? 'partial' : 'success'
      : 'failed',
    summary: {
      totalPhotos: images.length,
      analyzed: successful.length,
      failed: images.length - successful.length,
      categoryCounts: Object.fromEntries(CATEGORIES.map((category) => [category, byCategory[category].length])),
      averageConfidence: average(successful.map((image) => image.confidence)),
      lowConfidenceCount: successful.filter((image) => image.confidenceLevel === 'low').length,
      menuPhotosWithText: menuTexts.length,
      elapsedMs,
    },
    menuOcr: {
      status: byCategory.menu.length
        ? menuTexts.length ? 'success' : 'none'
        : 'not_applicable',
      menuPhotoCount: byCategory.menu.length,
      photosWithText: menuTexts.length,
      texts: menuTexts,
      combinedText: menuTexts.length
        ? menuTexts.map((entry) => `[Photo ${entry.photoId || 'unknown'}]\n${entry.text}`).join('\n\n')
        : null,
    },
    images,
    analyzedAt: new Date().toISOString(),
  };
}

function createEmptyReport(startedAt) {
  return {
    schemaVersion: 1,
    status: 'running',
    startedAt: startedAt.toISOString(),
    updatedAt: startedAt.toISOString(),
    finishedAt: null,
    resumedAt: null,
    inputPath,
    settings: {
      modelId,
      modelDtype,
      device,
      placeLimit,
      maxPhotosPerPlace,
      imageSize,
      minimumCategoryScore,
      minimumCategoryMargin,
      ocrLanguages,
      processingConcurrency: 1,
    },
    confidenceNotice: 'CLIP scores rank the supplied prompts and are not calibrated probabilities.',
    counts: calculateCounts([]),
    evaluation: null,
    restaurants: [],
  };
}

function calculateCounts(restaurants) {
  const images = restaurants.flatMap((restaurant) => restaurant.images || []);
  const analyzed = images.filter((image) => image.analysisStatus === 'success');
  return {
    restaurants: restaurants.length,
    restaurantsSuccess: restaurants.filter((restaurant) => restaurant.status === 'success').length,
    restaurantsPartial: restaurants.filter((restaurant) => restaurant.status === 'partial').length,
    restaurantsFailed: restaurants.filter((restaurant) => restaurant.status === 'failed').length,
    imagesTotal: images.length,
    imagesAnalyzed: analyzed.length,
    imagesFailed: images.length - analyzed.length,
    categories: Object.fromEntries(CATEGORIES.map((category) => [
      category,
      analyzed.filter((image) => image.category === category).length,
    ])),
    menuOcrSuccess: analyzed.filter((image) => image.ocr?.status === 'success').length,
    menuOcrFailed: analyzed.filter((image) => image.ocr?.status === 'failed').length,
  };
}

function evaluatePredictions(restaurants, labels) {
  const predictions = new Map(restaurants
    .flatMap((restaurant) => restaurant.images || [])
    .filter((image) => image.analysisStatus === 'success' && image.photoId)
    .map((image) => [image.photoId, image]));
  const usableLabels = labels.filter((label) => CATEGORIES.includes(label.actualCategory)
    && predictions.has(label.photoId));
  if (!usableLabels.length) {
    return {
      status: 'not_evaluated',
      labelsPath,
      labelledImages: 0,
      accuracy: null,
      macroPrecision: null,
      macroRecall: null,
      macroF1: null,
      perCategory: Object.fromEntries(CATEGORIES.map((category) => [category, emptyCategoryMetrics()])),
      confusionMatrix: emptyConfusionMatrix(),
      ocr: { status: 'not_evaluated', labelledImages: 0, meanCharacterAccuracy: null },
      note: `Fill actualCategory in a generated photo-labels-template.csv, save it as ${labelsPath}, then run npm run analyze:photos:evaluate.`,
    };
  }

  const matrix = emptyConfusionMatrix();
  for (const label of usableLabels) {
    matrix[label.actualCategory][predictions.get(label.photoId).category] += 1;
  }
  const perCategory = {};
  for (const category of CATEGORIES) {
    const truePositive = matrix[category][category];
    const falsePositive = CATEGORIES
      .filter((actual) => actual !== category)
      .reduce((sum, actual) => sum + matrix[actual][category], 0);
    const falseNegative = CATEGORIES
      .filter((predicted) => predicted !== category)
      .reduce((sum, predicted) => sum + matrix[category][predicted], 0);
    const support = Object.values(matrix[category]).reduce((sum, value) => sum + value, 0);
    const precision = safeDivide(truePositive, truePositive + falsePositive);
    const recall = safeDivide(truePositive, truePositive + falseNegative);
    perCategory[category] = {
      support,
      truePositive,
      falsePositive,
      falseNegative,
      precision,
      recall,
      f1: precision == null || recall == null || precision + recall === 0
        ? null
        : round((2 * precision * recall) / (precision + recall), 6),
    };
  }
  const correct = usableLabels.filter((label) =>
    predictions.get(label.photoId).category === label.actualCategory).length;
  const categoriesWithSupport = CATEGORIES.filter((category) => perCategory[category].support > 0);
  const ocrLabels = usableLabels.filter((label) => label.expectedOcrText
    && predictions.get(label.photoId).ocr?.text);
  const characterAccuracies = ocrLabels.map((label) => {
    const expected = normalizeEvaluationText(label.expectedOcrText);
    const actual = normalizeEvaluationText(predictions.get(label.photoId).ocr.text);
    return expected || actual
      ? 1 - (levenshteinDistance(expected, actual) / Math.max(expected.length, actual.length))
      : 1;
  });
  return {
    status: 'evaluated',
    labelsPath,
    labelledImages: usableLabels.length,
    accuracy: round(correct / usableLabels.length, 6),
    macroPrecision: meanMetric(categoriesWithSupport.map((category) => perCategory[category].precision)),
    macroRecall: meanMetric(categoriesWithSupport.map((category) => perCategory[category].recall)),
    macroF1: meanMetric(categoriesWithSupport.map((category) => perCategory[category].f1)),
    perCategory,
    confusionMatrix: matrix,
    ocr: {
      status: ocrLabels.length ? 'evaluated' : 'not_evaluated',
      labelledImages: ocrLabels.length,
      meanCharacterAccuracy: characterAccuracies.length ? average(characterAccuracies) : null,
    },
    note: 'Metrics apply only to the manually labelled sample, not automatically to every photo.',
  };
}

async function runEvaluationOnly() {
  const runRoot = await findLatestRun('photo-analysis.json');
  if (!runRoot) throw new Error(`No completed photo-analysis.json was found under ${outputRoot}.`);
  const finalPath = join(runRoot, 'photo-analysis.json');
  const report = JSON.parse(await readFile(finalPath, 'utf8'));
  const labels = await loadGroundTruth(labelsPath);
  report.evaluation = evaluatePredictions(report.restaurants || [], labels);
  report.updatedAt = new Date().toISOString();
  await writeJson(finalPath, report);
  await writeJson(join(runRoot, 'evaluation.json'), report.evaluation);
  // Evaluation reads the completed labels file and does not need to regenerate
  // the template. Skipping that derived file also avoids Windows/Excel locks
  // preventing otherwise valid evaluation results from being saved.
  console.log(`Evaluation status: ${report.evaluation.status}`);
  console.log(`Labelled images: ${report.evaluation.labelledImages}`);
  console.log(`Accuracy: ${formatPercent(report.evaluation.accuracy)}`);
  console.log(`Macro precision: ${formatPercent(report.evaluation.macroPrecision)}`);
  console.log(`Updated: ${finalPath}`);
}

async function downloadImage(url, timeoutMs) {
  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 photo-analysis/1.0' },
      });
      if (!response.ok) throw new Error(`Image request returned HTTP ${response.status}.`);
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.startsWith('image/')) throw new Error(`Expected an image but received ${contentType || 'unknown content type'}.`);
      const declaredBytes = Number(response.headers.get('content-length'));
      if (Number.isFinite(declaredBytes) && declaredBytes > 25_000_000) {
        throw new Error(`Image response is too large (${declaredBytes} bytes).`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length) throw new Error('Image response was empty.');
      if (buffer.length > 25_000_000) throw new Error(`Downloaded image is too large (${buffer.length} bytes).`);
      return { buffer, contentType };
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(600);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error('Image download failed.');
}

async function loadGroundTruth(path) {
  if (!await fileExists(path)) return [];
  const text = await readFile(path, 'utf8');
  if (path.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text);
    const records = Array.isArray(parsed) ? parsed : parsed.labels;
    return Array.isArray(records) ? records.map(normalizeLabel) : [];
  }
  return parseCsv(text).map(normalizeLabel);
}

function normalizeLabel(label) {
  return {
    photoId: String(label.photoId || '').trim(),
    actualCategory: String(label.actualCategory || '').trim().toLowerCase(),
    expectedOcrText: String(label.expectedOcrText || '').trim() || null,
  };
}

async function writeLabelsTemplate(path, restaurants, existingLabels) {
  const labelsById = new Map(existingLabels.map((label) => [label.photoId, label]));
  const header = [
    'restaurantName', 'photoId', 'imageUrl', 'predictedCategory', 'confidence',
    'actualCategory', 'expectedOcrText',
  ];
  const rows = restaurants.flatMap((restaurant) => (restaurant.images || [])
    .filter((image) => image.analysisStatus === 'success')
    .map((image) => {
      const label = labelsById.get(image.photoId) || {};
      return [
        restaurant.name,
        image.photoId,
        image.originalFullSizeImageUrl || image.analysisImageUrl,
        image.category,
        image.confidence,
        label.actualCategory || '',
        label.expectedOcrText || '',
      ];
    }));
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  await writeFileWithRetry(path, `${csv}\n`);
}

async function writeFileWithRetry(path, contents, attempts = 10) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await writeFile(path, contents, 'utf8');
      return;
    } catch (error) {
      lastError = error;
      const retryable = ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(error?.code);
      if (!retryable || attempt === attempts) break;
      await sleep(Math.min(150 * attempt, 1_000));
    }
  }
  throw new Error(`Could not write ${basename(path)} after ${attempts} attempts: ${conciseError(lastError)}`);
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
  return rows.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] || ''])));
}

async function findLatestRun(filename) {
  const entries = await readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outputRoot, entry.name))
    .sort((left, right) => basename(right).localeCompare(basename(left)));
  for (const candidate of candidates) {
    if (await fileExists(join(candidate, filename))) return candidate;
  }
  return null;
}

async function findLatestIncompleteRun() {
  const entries = await readdir(outputRoot, { withFileTypes: true }).catch(() => []);
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(outputRoot, entry.name))
    .sort((left, right) => basename(right).localeCompare(basename(left)));
  for (const candidate of candidates) {
    const partialPath = join(candidate, 'photo-analysis.partial.json');
    if (!await fileExists(partialPath) || await fileExists(join(candidate, 'photo-analysis.json'))) continue;
    const partial = JSON.parse(await readFile(partialPath, 'utf8'));
    if (partial.status !== 'complete') return candidate;
  }
  return null;
}

function modelProgressLogger() {
  const lastPercentByFile = new Map();
  return (progress) => {
    if (progress.status !== 'progress' || !progress.file || !Number.isFinite(progress.progress)) return;
    const rounded = Math.floor(progress.progress / 10) * 10;
    if (lastPercentByFile.get(progress.file) === rounded) return;
    lastPercentByFile.set(progress.file, rounded);
    if (rounded % 20 === 0 || rounded === 100) console.log(`  Model ${progress.file}: ${rounded}%`);
  };
}

function ocrProgressLogger() {
  let lastProgress = -1;
  return (message) => {
    if (message.status !== 'recognizing text' || !Number.isFinite(message.progress)) return;
    const rounded = Math.floor(message.progress * 4) * 25;
    if (rounded > lastProgress && rounded < 100) {
      lastProgress = rounded;
      console.log(`  OCR progress: ${rounded}%`);
    }
    if (rounded >= 100) lastProgress = -1;
  };
}

function confidenceLabel(score, margin, forcedUnknown) {
  if (forcedUnknown) return 'low';
  if (score >= 0.65 && margin >= 0.25) return 'high';
  if (score >= minimumCategoryScore && margin >= minimumCategoryMargin) return 'medium';
  return 'low';
}

function makeResizedGoogleImageUrl(value, size) {
  try {
    const url = new URL(value);
    if (/googleusercontent\.com$/i.test(url.hostname)) {
      url.pathname = url.pathname.replace(/=[^/=]+$/, `=s${size}`);
      return url.toString();
    }
  } catch {}
  return value;
}

function cleanOcrText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function emptyCategoryMetrics() {
  return {
    support: 0,
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    precision: null,
    recall: null,
    f1: null,
  };
}

function emptyConfusionMatrix() {
  return Object.fromEntries(CATEGORIES.map((actual) => [
    actual,
    Object.fromEntries(CATEGORIES.map((predicted) => [predicted, 0])),
  ]));
}

function levenshteinDistance(left, right) {
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function normalizeEvaluationText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function placeKey(place) {
  return place.googleMapsUrl || `${place.name || ''}|${place.area || ''}`;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length ? round(usable.reduce((sum, value) => sum + value, 0) / usable.length, 6) : null;
}

function meanMetric(values) {
  const usable = values.filter((value) => value != null && Number.isFinite(value));
  return usable.length ? average(usable) : null;
}

function safeDivide(numerator, denominator) {
  return denominator ? round(numerator / denominator, 6) : null;
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, decimals) {
  const multiplier = 10 ** decimals;
  return Math.round(value * multiplier) / multiplier;
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInteger(value) {
  if (value == null || !String(value).trim() || /^all$/i.test(String(value).trim())) return null;
  const parsed = Number.parseInt(value, 10);
  if (Number.isInteger(parsed) && parsed > 0) return parsed;
  throw new Error('PHOTO_ANALYSIS_PLACE_LIMIT must be empty, "all", or a positive integer.');
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function decimalBetweenZeroAndOne(value, fallback) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : 'n/a';
}

function timestampForPath(date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function csvCell(value) {
  const text = value == null ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function conciseError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 500);
}

async function fileExists(path) {
  return access(path).then(() => true).catch(() => false);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
