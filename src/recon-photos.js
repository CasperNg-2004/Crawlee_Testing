// One-off investigation script. It does NOT scrape at scale.
// For each place it opens the photo gallery, clicks the All / Menu / By owner chips,
// and records what Google Maps exposes: thumbnails in the DOM, the text shown when a
// single photo is opened (upload date?), and the raw network responses behind the gallery
// (dates, dimensions, video flags?). Relevant response bodies are retained only when they
// mention observed photo IDs. Inspect the resulting output/recon folder before sharing it.
//
// Run (close any other Chrome window using .chrome-profile first):
//   node --env-file=.env src/recon-photos.js
// Choose places with RECON_PLACES, separated by |. Each entry may be a Maps URL or a search phrase:
//   $env:RECON_PLACES = 'Yellow Fin Horse, Kuala Lumpur|https://www.google.com/maps/place/...'
// Optional sampling limits: RECON_SCROLL_ROUNDS, RECON_VIEWER_STEPS, RECON_MAX_PHOTOS,
// RECON_MAX_RESPONSES_PER_CHIP, and RECON_MAX_BODY_CHARS.

import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const places = (process.env.RECON_PLACES?.trim() || 'Yellow Fin Horse, Kuala Lumpur')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
if (places.some((place) => /<[^>]+>/.test(place))) {
  throw new Error('RECON_PLACES still contains a <placeholder>. Replace it with a real place or remove it.');
}
const chromeProfileDir = resolve(process.env.CHROME_PROFILE_DIR?.trim() || '.chrome-profile');
const outputRoot = resolve(process.env.RECON_OUTPUT_DIR?.trim() || 'output/recon');
const runRoot = join(outputRoot, new Date().toISOString().replace(/[:.]/g, '-'));
const chips = ['All', 'Menu', 'By owner'];
const scrollRounds = positiveInteger(process.env.RECON_SCROLL_ROUNDS, 80);
const viewerSteps = positiveInteger(process.env.RECON_VIEWER_STEPS, 5);
const maxPhotos = positiveInteger(process.env.RECON_MAX_PHOTOS, 500);
const maxResponsesPerChip = positiveInteger(process.env.RECON_MAX_RESPONSES_PER_CHIP, 30);
const maxBodyChars = positiveInteger(process.env.RECON_MAX_BODY_CHARS, 750_000);
const downloadPhotos = process.env.RECON_DOWNLOAD_PHOTOS?.toLowerCase() !== 'false';

const context = await chromium.launchPersistentContext(chromeProfileDir, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1400, height: 900 },
  locale: 'en-MY',
  args: ['--disable-background-mode'],
});
await context.setExtraHTTPHeaders({ 'Accept-Language': 'en-MY,en;q=0.9' });

try {
for (const [placeIndex, place] of places.entries()) {
  const page = await context.newPage();
  const dir = join(runRoot, `${String(placeIndex + 1).padStart(2, '0')}-${slugify(place)}`);
  await mkdir(join(dir, 'responses'), { recursive: true });
  const capture = startNetworkCapture(page);
  let placeNavigationUrl = null;
  const report = {
    input: /^https?:\/\//i.test(place) ? redactUrl(place) : place,
    placeName: null,
    placeUrl: null,
    galleryChipsSeen: [],
    sampling: { scrollRounds, viewerSteps, maxPhotos, downloadPhotos },
    chips: {},
    warnings: [],
    errors: [],
  };

  console.log(`\n=== ${place}`);
  try {
  try {
    capture.setPhase('open-place');
    const openedPlace = await openPlace(page, place);
    placeNavigationUrl = openedPlace.url;
    report.placeUrl = redactUrl(openedPlace.url);
    report.placeName = openedPlace.name;
    if (!/^https?:\/\//i.test(place) && !looselyMatchesPlaceName(place, openedPlace.name)) {
      report.warnings.push(`First search result may not match input: opened "${openedPlace.name}".`);
    }
    await safeScreenshot(page, join(dir, '00-place.png'));

    for (const [chipIndex, chip] of chips.entries()) {
      const prefix = `${String(chipIndex + 1).padStart(2, '0')}-${slugify(chip)}`;
      const chipReport = {
        clicked: false,
        domPhotoCount: 0,
        networkPhotoCount: 0,
        photoCount: 0,
        downloadedCount: 0,
        photos: [],
        viewer: [],
        scroll: [],
        error: null,
      };
      report.chips[chip] = chipReport;

      try {
        // Start each chip from a fresh place page so earlier clicks cannot affect it.
        capture.setPhase(`${chip}: open gallery`);
        await page.goto(placeNavigationUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await page.locator('div[role="main"] h1').first().waitFor({ state: 'visible', timeout: 20_000 });
        await page.waitForTimeout(1_500);

        if (!await openGallery(page)) {
          chipReport.error = 'No photo gallery opener found';
          continue;
        }
        if (!report.galleryChipsSeen.length) report.galleryChipsSeen = await listVisibleTabs(page);

        capture.setPhase(`${chip}: click chip`);
        chipReport.clicked = await clickChip(page, chip);
        if (!chipReport.clicked) {
          chipReport.error = `Chip "${chip}" not visible`;
          await safeScreenshot(page, join(dir, `${prefix}-missing.png`));
          continue;
        }
        await page.locator('a.MIgS0d[data-photo-index]').first()
          .waitFor({ state: 'attached', timeout: 10_000 }).catch(() => {});

        capture.setPhase(`${chip}: scroll grid`);
        const photosById = new Map();
        let stalledRounds = 0;
        const rememberLoadedPhotos = async () => {
          const loadedPhotos = await describeGalleryPhotos(page, maxPhotos);
          const before = photosById.size;
          for (const photo of loadedPhotos) {
            const identity = photoIdentity(photo.src);
            if (identity && !photosById.has(identity)) photosById.set(identity, photo);
            if (photosById.size >= maxPhotos) break;
          }
          return photosById.size - before;
        };

        await rememberLoadedPhotos();
        for (let round = 0; round < scrollRounds; round += 1) {
          const scrollState = await scrollGallery(page);
          await page.waitForTimeout(1_200);
          const added = await rememberLoadedPhotos();
          chipReport.scroll.push({ round: round + 1, added, total: photosById.size, ...scrollState });
          stalledRounds = added === 0 ? stalledRounds + 1 : 0;
          if ((stalledRounds >= 3 && scrollState.atBottom) || photosById.size >= maxPhotos) break;
        }
        await safeScreenshot(page, join(dir, `${prefix}-grid.png`));
        chipReport.photos = [...photosById.values()];
        chipReport.photoCount = chipReport.photos.length;

        capture.setPhase(`${chip}: photo viewer`);
        chipReport.viewer = await captureViewer(page, dir, prefix);
      } catch (error) {
        chipReport.error = error.message;
      }
      console.log(`${chip}: clicked=${chipReport.clicked} photos=${chipReport.photoCount}`
        + `${chipReport.error ? ` error=${chipReport.error}` : ''}`);
    }
  } catch (error) {
    report.errors.push(error.message);
    console.log(`Failed: ${error.message}`);
    await safeScreenshot(page, join(dir, 'failed.png')).catch(() => {});
  }

  const responses = await capture.finish();
  const photoIds = collectPhotoIds(report);
  const networkPhotosByChip = new Map(chips.map((chip) => [chip, new Map()]));
  const index = [];
  for (const entry of responses) {
    const { body, ...meta } = entry;
    if (body) {
      const matched = photoIds.filter((id) => body.includes(id.slice(0, 30)));
      const networkPhotoUrls = extractGooglePhotoUrls(body);
      const chipName = chips.find((chip) => entry.phase.startsWith(`${chip}:`));
      meta.matchedPhotoIds = matched.length;
      meta.discoveredPhotoUrls = networkPhotoUrls.length;
      if (chipName) {
        const chipPhotos = networkPhotosByChip.get(chipName);
        for (const source of networkPhotoUrls) chipPhotos.set(photoIdentity(source), source);
      }
      if (matched.length || networkPhotoUrls.length) {
        meta.file = `responses/${String(entry.index).padStart(3, '0')}.txt`;
        await writeFile(join(dir, meta.file), body, 'utf8');
        const firstNeedle = matched[0]?.slice(0, 30) || networkPhotoUrls[0]?.slice(0, 30);
        const at = firstNeedle ? body.indexOf(firstNeedle) : -1;
        if (at >= 0) meta.snippetAroundFirstMatch = body.slice(Math.max(0, at - 400), at + 800);
      } else {
        meta.bodyDiscarded = true;
      }
    }
    index.push(meta);
  }

  for (const chip of chips) {
    const chipReport = report.chips[chip];
    if (!chipReport) continue;
    const merged = new Map();
    for (const photo of chipReport.photos) {
      photo.discoverySource = 'dom';
      merged.set(photoIdentity(photo.src), photo);
    }
    chipReport.domPhotoCount = merged.size;
    let networkAdded = 0;
    for (const source of networkPhotosByChip.get(chip).values()) {
      const identity = photoIdentity(source);
      if (!identity || merged.has(identity) || merged.size >= maxPhotos) continue;
      merged.set(identity, {
        src: source,
        photoIndex: null,
        ariaLabel: null,
        holderText: null,
        looksLikeVideo: false,
        renderedSize: null,
        discoverySource: 'network',
      });
      networkAdded += 1;
    }
    chipReport.networkPhotoCount = networkAdded;
    chipReport.photos = [...merged.values()];
    chipReport.photoCount = chipReport.photos.length;

    if (downloadPhotos && chipReport.photos.length) {
      const photoDir = join(dir, 'photos', slugify(chip));
      const downloads = await downloadGalleryPhotos(context.request, chipReport.photos, photoDir);
      chipReport.downloadedCount = downloads.filter(({ downloaded }) => downloaded).length;
      for (let index = 0; index < chipReport.photos.length; index += 1) {
        chipReport.photos[index].download = downloads[index];
      }
    }
  }

  await writeFile(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  await writeFile(join(dir, 'responses.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8');
  const dataResponses = index.filter((entry) => entry.matchedPhotoIds > 0 || entry.discoveredPhotoUrls > 0).length;
  console.log(`Saved to ${dir} (${responses.length} responses, ${dataResponses} contain photo data)`);
  } finally {
    await page.close().catch(() => {});
  }
}
} finally {
  await context.close().catch(() => {});
}
console.log(`\nDone. Results are in ${runRoot}. Inspect them for personal data before sharing.`);
console.log(`To archive only this run:\n  Compress-Archive -Path "${runRoot}" -DestinationPath recon.zip -Force`);

// ---------------------------------------------------------------------------

function startNetworkCapture(page) {
  const responses = [];
  const pending = [];
  const responseCounts = new Map();
  let phase = 'start';
  let active = true;

  page.on('response', (response) => {
    if (!active || !/: (?:click chip|scroll grid|photo viewer)$/.test(phase)) return;
    const request = response.request();
    if (!['xhr', 'fetch'].includes(request.resourceType())) return;
    const rawUrl = response.url();
    if (!/^https:\/\/www\.google\.[^/]+\//.test(rawUrl) || !/\/maps\//i.test(rawUrl)) return;
    const chip = phase.split(':')[0];
    const capturedForChip = responseCounts.get(chip) || 0;
    if (capturedForChip >= maxResponsesPerChip) return;
    responseCounts.set(chip, capturedForChip + 1);

    const entry = {
      index: responses.length,
      phase,
      resourceType: request.resourceType(),
      status: response.status(),
      url: redactUrl(rawUrl),
      contentType: response.headers()['content-type'] || null,
    };
    responses.push(entry);
    const declaredLength = Number(response.headers()['content-length'] || 0);
    if (declaredLength > maxBodyChars * 2) {
      entry.size = declaredLength;
      entry.bodySkipped = 'Declared response size exceeds capture limit';
      return;
    }
    pending.push(response.text()
      .then((body) => {
        entry.size = body.length;
        entry.truncated = body.length > maxBodyChars;
        entry.body = body.slice(0, maxBodyChars) || null;
      })
      .catch((error) => { entry.error = error.message; }));
  });

  return {
    setPhase: (value) => { phase = value; },
    finish: async () => {
      active = false;
      await Promise.allSettled(pending);
      return responses;
    },
  };
}

async function openPlace(page, place) {
  const url = /^https?:\/\//i.test(place)
    ? place
    : `https://www.google.com/maps/search/${encodeURIComponent(place)}?hl=en`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await acceptConsentIfShown(page);
  await page.waitForFunction(() => document.querySelector('div[role="feed"]')
    || document.querySelector('div[role="main"] h1'), null, { timeout: 30_000 });

  const feed = page.locator('div[role="feed"]');
  if (await feed.isVisible().catch(() => false)) {
    const firstResult = feed.locator('a[href*="/maps/place/"]').first();
    await firstResult.waitFor({ state: 'visible', timeout: 20_000 });
    await firstResult.click();
  }
  const heading = page.locator('div[role="main"] h1').first();
  await heading.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(2_000);
  return { url: page.url(), name: (await heading.textContent())?.trim() || null };
}

async function acceptConsentIfShown(page) {
  for (const name of [/accept all/i, /agree/i]) {
    const button = page.getByRole('button', { name }).first();
    if (await button.isVisible().catch(() => false)) {
      await button.click();
      await page.waitForTimeout(750);
      return;
    }
  }
}

async function openGallery(page) {
  const candidates = [
    page.getByRole('tab', { name: /^photos?\b/i }).first(),
    page.locator('button[aria-label^="Photo of" i]').first(),
    page.locator('button[aria-label*="photo" i]').first(),
  ];
  for (const candidate of candidates) {
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click();
      await page.waitForTimeout(2_000);
      return true;
    }
  }
  return false;
}

async function listVisibleTabs(page) {
  return page.locator('[role="tab"]').evaluateAll((tabs) => tabs
    .filter((tab) => tab.getBoundingClientRect().width > 0)
    .map((tab) => ({
      text: tab.innerText.replace(/\s+/g, ' ').trim(),
      ariaLabel: tab.getAttribute('aria-label'),
      selected: tab.getAttribute('aria-selected'),
    })));
}

async function clickChip(page, name) {
  const pattern = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i');
  const candidates = [
    page.getByRole('tab', { name: pattern }),
    page.getByRole('button', { name: pattern }),
    page.locator('[role="tab"], button').filter({ hasText: pattern }),
  ];
  for (const candidate of candidates) {
    const first = candidate.first();
    if (await first.isVisible().catch(() => false)) {
      await first.click();
      await page.waitForTimeout(2_000);
      return true;
    }
  }
  return false;
}

async function scrollGallery(page) {
  const directState = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')];
    const anchor = cards.find((card) => {
      const box = card.getBoundingClientRect();
      return box.width > 0 && box.height > 0;
    });
    let scroller = anchor?.parentElement;
    while (scroller && scroller !== document.body) {
      const box = scroller.getBoundingClientRect();
      if (scroller.scrollHeight > scroller.clientHeight + 20 && box.width > 0 && box.width < 700) break;
      scroller = scroller.parentElement;
    }
    if (!scroller || scroller === document.body) return null;
    const before = scroller.scrollTop;
    scroller.scrollBy(0, Math.max(Math.floor(scroller.clientHeight * 0.85), 650));
    return {
      method: 'scroll-container',
      before,
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      atBottom: scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 5,
      maxPhotoIndex: Math.max(-1, ...cards.map((card) => Number(card.dataset.photoIndex))),
    };
  });
  if (directState?.scrollTop > directState?.before || directState?.atBottom) return directState;

  const lastVisibleCard = page.locator('a.MIgS0d[data-photo-index]:visible').last();
  const box = await lastVisibleCard.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + Math.min(box.width / 2, 150), box.y + Math.min(box.height / 2, 150));
    await page.mouse.wheel(0, 1_000);
  }
  return {
    method: box ? 'mouse-wheel' : 'none',
    before: directState?.before ?? null,
    scrollTop: directState?.scrollTop ?? null,
    scrollHeight: directState?.scrollHeight ?? null,
    clientHeight: directState?.clientHeight ?? null,
    atBottom: directState?.atBottom ?? false,
    maxPhotoIndex: await page.locator('a.MIgS0d[data-photo-index]').evaluateAll((cards) =>
      Math.max(-1, ...cards.map((card) => Number(card.dataset.photoIndex))),
    ).catch(() => -1),
  };
}

async function describeGalleryPhotos(page, limit) {
  return page.evaluate((photoLimit) => {
    const placePhoto = /^https:\/\/lh\d+\.googleusercontent\.com\/(?:p|gps-cs-s)\//;
    const sourceOf = (element) => element?.style.backgroundImage
      .match(/url\(["']?(.*?)["']?\)/)?.[1] || '';
    const cards = [...document.querySelectorAll('a.MIgS0d[data-photo-index]')];

    document.querySelectorAll('[data-recon-first]').forEach((element) => element.removeAttribute('data-recon-first'));

    const results = [];
    const seenPhotos = new Set();
    for (const card of cards) {
      const imageElements = [...card.querySelectorAll('[style*="googleusercontent"]')];
      const source = imageElements.map(sourceOf).find((value) => placePhoto.test(value)) || '';
      const photoId = source.match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=]+)/)?.[1];
      const identity = photoId || source.replace(/=[^/]*$/, '');
      if (!identity || seenPhotos.has(identity)) continue;
      seenPhotos.add(identity);
      const box = card.getBoundingClientRect();
      const visible = box.bottom > 0 && box.top < innerHeight && box.right > 0 && box.left < innerWidth;
      if (visible && !document.querySelector('[data-recon-first]')) card.setAttribute('data-recon-first', 'true');
      const holderText = (card.innerText || '').replace(/\s+/g, ' ').trim();
      const holderLabel = card.getAttribute('aria-label') || null;
      results.push({
        src: source,
        photoIndex: Number.isFinite(Number(card.dataset.photoIndex)) ? Number(card.dataset.photoIndex) : null,
        tag: card.tagName,
        ariaLabel: holderLabel,
        holderText: holderText.slice(0, 160),
        looksLikeVideo: /\b\d{1,2}:\d{2}\b/.test(holderText) || /video/i.test(holderLabel || '')
          || Boolean(card.querySelector('video, [aria-label*="video" i]')),
        renderedSize: [Math.round(box.width), Math.round(box.height)],
        discoverySource: 'dom',
        sampleHtml: results.length < 3 ? card.outerHTML.slice(0, 4_000) : undefined,
      });
      if (results.length >= photoLimit) break;
    }
    return results;
  }, limit);
}

async function captureViewer(page, dir, prefix) {
  const first = page.locator('[data-recon-first]').first();
  if (!await first.isVisible().catch(() => false)) return [];
  await first.click();

  const steps = [];
  for (let step = 0; step < viewerSteps; step += 1) {
    await page.waitForTimeout(2_500);
    await safeScreenshot(page, join(dir, `${prefix}-viewer-${step + 1}.png`));
    const stepReport = await page.evaluate(() => {
      const dateLike = /\bago\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(?:\d{1,2},?\s+)?(?:19|20)\d{2}\b|\b(?:19|20)\d{2}\b/i;
      const lines = document.body.innerText.split(/\n+/).map((line) => line.trim()).filter(Boolean);
      const labels = [...document.querySelectorAll('[aria-label]')].map((element) => element.getAttribute('aria-label'));
      return {
        url: location.href,
        dateLikeText: [...new Set(lines.filter((line) => line.length < 120 && dateLike.test(line)))].slice(0, 40),
        dateLikeAriaLabels: [...new Set(labels.filter((label) => label && label.length < 160 && dateLike.test(label)))].slice(0, 40),
        largeImages: [...document.querySelectorAll('img')]
          .filter((image) => image.naturalWidth >= 400)
          .map((image) => ({ src: image.currentSrc || image.src, natural: [image.naturalWidth, image.naturalHeight] }))
          .slice(0, 5),
        largeBackgroundImages: [...document.querySelectorAll('[style*="googleusercontent"]')]
          .map((element) => {
            const box = element.getBoundingClientRect();
            const src = element.style.backgroundImage.match(/url\(["']?(.*?)["']?\)/)?.[1] || null;
            return { src, rendered: [Math.round(box.width), Math.round(box.height)] };
          })
          .filter(({ src, rendered }) => src && rendered[0] >= 400 && rendered[1] >= 300)
          .slice(0, 5),
      };
    });
    stepReport.url = redactUrl(stepReport.url);
    steps.push(stepReport);
    await page.keyboard.press('ArrowRight').catch(() => {});
  }
  await page.keyboard.press('Escape').catch(() => {});
  return steps;
}

function collectPhotoIds(report) {
  const ids = new Set();
  for (const chip of Object.values(report.chips)) {
    for (const photo of chip.photos) {
      const id = photo.src.match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=]+)/)?.[1];
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function photoIdentity(source) {
  return source.match(/googleusercontent\.com\/(?:p|gps-cs-s)\/([^=]+)/)?.[1]
    || source.replace(/=[^/]*$/, '');
}

function extractGooglePhotoUrls(body) {
  const normalized = body
    .replaceAll('\\u003d', '=')
    .replaceAll('\\u0026', '&')
    .replaceAll('\\/', '/');
  const matches = normalized.match(/(?:https?:)?\/\/lh\d+\.googleusercontent\.com\/(?:p|gps-cs-s)\/[A-Za-z0-9_-]+(?:=[A-Za-z0-9_-]+)?/g) || [];
  const photos = new Map();
  for (const match of matches) {
    const source = match.startsWith('//') ? `https:${match}` : match;
    const identity = photoIdentity(source);
    if (identity && !photos.has(identity)) photos.set(identity, source);
  }
  return [...photos.values()];
}

async function downloadGalleryPhotos(request, photos, directory) {
  await mkdir(directory, { recursive: true });
  const results = new Array(photos.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < photos.length) {
      const index = cursor;
      cursor += 1;
      const photo = photos[index];
      if (photo.looksLikeVideo) {
        results[index] = { downloaded: false, reason: 'video' };
        continue;
      }

      const candidates = [...new Set([
        upgradeGoogleImageUrl(photo.src, 1600),
        upgradeGoogleImageUrl(photo.src, 1200),
        photo.src,
      ])];
      let failure = { downloaded: false, reason: 'No download candidate succeeded' };
      for (const source of candidates) {
        try {
          const response = await request.get(source, { timeout: 30_000 });
          if (!response.ok()) {
            failure = { downloaded: false, status: response.status(), reason: 'HTTP error' };
            await response.dispose();
            continue;
          }
          const contentType = response.headers()['content-type'] || '';
          const body = await response.body();
          await response.dispose();
          if (!contentType.startsWith('image/')) {
            failure = { downloaded: false, reason: `Unexpected content type: ${contentType || 'unknown'}` };
            continue;
          }
          if (body.length > 25_000_000) {
            failure = { downloaded: false, reason: 'Image exceeds 25 MB safety limit' };
            continue;
          }
          const extension = extensionForContentType(contentType);
          const hash = createHash('sha256').update(photoIdentity(photo.src)).digest('hex').slice(0, 12);
          const indexLabel = String(photo.photoIndex ?? index).padStart(4, '0');
          const filename = `${indexLabel}-${hash}.${extension}`;
          await writeFile(join(directory, filename), body);
          results[index] = {
            downloaded: true,
            file: filename,
            bytes: body.length,
            contentType,
            sha256: createHash('sha256').update(body).digest('hex'),
          };
          break;
        } catch (error) {
          failure = { downloaded: false, reason: error.message };
        }
      }
      if (!results[index]) results[index] = failure;
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, photos.length) }, worker));

  const firstFileByHash = new Map();
  for (const result of results) {
    if (!result.downloaded) continue;
    const firstFile = firstFileByHash.get(result.sha256);
    if (!firstFile) {
      firstFileByHash.set(result.sha256, result.file);
      continue;
    }
    await unlink(join(directory, result.file)).catch(() => {});
    Object.assign(result, {
      downloaded: false,
      duplicateOf: firstFile,
      reason: 'duplicate content',
    });
    delete result.file;
  }
  return results;
}

function upgradeGoogleImageUrl(source, size) {
  return `${source.replace(/=[^/]*$/, '')}=s${size}-k-no`;
}

function extensionForContentType(contentType) {
  if (/png/i.test(contentType)) return 'png';
  if (/webp/i.test(contentType)) return 'webp';
  if (/gif/i.test(contentType)) return 'gif';
  return 'jpg';
}

function slugify(value) {
  return value.replace(/^https?:\/\/[^/]+\/maps\/place\//i, '')
    .replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60).toLowerCase() || 'place';
}

function looselyMatchesPlaceName(input, actualName) {
  if (!actualName) return false;
  const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const requestedName = normalize(input.split(',')[0]);
  const openedName = normalize(actualName);
  return requestedName.length >= 3
    && (openedName.includes(requestedName) || requestedName.includes(openedName));
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    const parameterNames = [...new Set(url.searchParams.keys())].sort();
    url.search = parameterNames.length ? `?${parameterNames.join('&')}` : '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[invalid URL]';
  }
}

async function safeScreenshot(page, path) {
  const masks = [
    page.locator('a[href*="accounts.google.com"]'),
    page.locator('[aria-label*="Google Account" i]'),
  ];
  await page.screenshot({ path, animations: 'disabled', mask: masks });
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}
