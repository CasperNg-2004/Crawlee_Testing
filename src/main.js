import { mkdir, writeFile } from 'node:fs/promises';
import { PlaywrightCrawler, Dataset, createPlaywrightRouter, log } from 'crawlee';

const query = process.env.QUERY?.trim() || 'restaurant';
const area = process.env.AREA?.trim() || 'Kuala Lumpur, Malaysia';
const maxPlaces = positiveInteger(process.env.MAX_PLACES, 1000);
const maxStalledScrolls = positiveInteger(process.env.MAX_STALLED_SCROLLS, 12);
const scrollWaitMs = positiveInteger(process.env.SCROLL_WAIT_MS, 2_000);
const headless = process.env.HEADLESS?.toLowerCase() !== 'false';
const outputDir = process.env.OUTPUT_DIR?.trim() || 'output';
const areas = (process.env.AREAS?.trim() || area)
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const runStartedAt = Date.now();

let queuedPlaceCount = 0;
let successfulPlaceCount = 0;
let failedPlaceCount = 0;
const seenPlaceUrls = new Set();

const router = createPlaywrightRouter();

router.addHandler('SEARCH', async ({ page, request, addRequests, log: requestLog }) => {
  await acceptConsentIfShown(page);

  const feed = page.locator('div[role="feed"]');
  await feed.waitFor({ state: 'visible', timeout: 30_000 });

  const placeUrls = new Set();
  let unchangedRounds = 0;

  while (queuedPlaceCount + placeUrls.size < maxPlaces && unchangedRounds < maxStalledScrolls) {
    const before = placeUrls.size;
    const urls = await feed.locator('a[href*="/maps/place/"]').evaluateAll((links) =>
      links.map((link) => link.href),
    );

    for (const url of urls) {
      const cleanedUrl = cleanPlaceUrl(url);
      if (!seenPlaceUrls.has(cleanedUrl)) placeUrls.add(cleanedUrl);
      if (queuedPlaceCount + placeUrls.size >= maxPlaces) break;
    }

    const endOfList = await feed.getByText(/reached the end of the list/i).isVisible().catch(() => false);
    if (endOfList) {
      requestLog.info(`Reached the end of results for ${request.userData.area}; found ${placeUrls.size} new places.`);
      break;
    }

    unchangedRounds = placeUrls.size === before ? unchangedRounds + 1 : 0;
    const links = feed.locator('a[href*="/maps/place/"]');
    const linkCount = await links.count();
    if (linkCount > 0) await links.nth(linkCount - 1).scrollIntoViewIfNeeded();
    await feed.evaluate((element) => element.scrollBy(0, Math.max(element.clientHeight, 800)));
    await page.waitForTimeout(scrollWaitMs);

    if (placeUrls.size > before) {
      requestLog.info(`Discovery progress for ${request.userData.area}: ${placeUrls.size} new places.`);
    }
  }

  const requests = [];
  for (const url of placeUrls) {
    if (queuedPlaceCount + requests.length >= maxPlaces) break;
    if (seenPlaceUrls.has(url)) continue;
    seenPlaceUrls.add(url);
    requests.push({
      url,
      uniqueKey: url,
      label: 'DETAIL',
      userData: { searchUrl: request.url, query, area: request.userData.area },
    });
  }

  queuedPlaceCount += requests.length;
  await addRequests(requests);
  requestLog.info(`Queued ${requests.length} new pages from ${request.userData.area}; ${queuedPlaceCount} total.`);
});

router.addHandler('DETAIL', async ({ page, request, pushData, log: requestLog }) => {
  await acceptConsentIfShown(page);
  await page.locator('h1').first().waitFor({ state: 'visible', timeout: 20_000 });

  const hoursExpander = page.getByLabel(/show open hours for the week/i).first();
  if (await hoursExpander.isVisible().catch(() => false)) {
    await hoursExpander.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Scroll the details panel so Maps lazy-loads sections such as Popular times.
  const detailsPanel = page.locator('div[role="main"]').first();
  if (await detailsPanel.isVisible().catch(() => false)) {
    for (let index = 0; index < 5; index += 1) {
      await detailsPanel.evaluate((element) => element.scrollBy(0, 900)).catch(() => {});
      await page.waitForTimeout(250);
    }
  }

  const canonicalUrl = page.url();
  const coordinates = coordinatesFromUrl(canonicalUrl);
  const details = await page.evaluate(() => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const unique = (values) => [...new Set(values.filter(Boolean))];
    const text = (selector) => clean(document.querySelector(selector)?.textContent);
    const aria = (selector) => clean(document.querySelector(selector)?.getAttribute('aria-label'));
    const itemText = (prefix) => {
      const element = document.querySelector(`[data-item-id^="${prefix}"]`);
      return clean(element?.getAttribute('aria-label') || element?.textContent);
    };
    const stripLabel = (value, labels) => {
      if (!value) return null;
      for (const label of labels) {
        value = value.replace(new RegExp(`^${label}\\s*:?\\s*`, 'i'), '');
      }
      return clean(value);
    };

    const ariaLabels = [...document.querySelectorAll('[aria-label]')]
      .map((element) => clean(element.getAttribute('aria-label')))
      .filter(Boolean);
    const ratingLabel = ariaLabels.find((label) => /\bstars?\b/i.test(label));
    const reviewsLabel = ariaLabels.find((label) => /\breviews?\b/i.test(label));
    const websiteElement = document.querySelector('a[data-item-id="authority"]');
    const menuLink = [...document.querySelectorAll('a[href]')].find((element) =>
      /\bmenus?\b/i.test(`${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`),
    );
    const menuAvailable = Boolean(menuLink)
      || [...document.querySelectorAll('button, [role="tab"]')].some((element) =>
        /\bmenus?\b/i.test(`${element.getAttribute('aria-label') || ''} ${element.textContent || ''}`),
      );
    const category = text('button[jsaction*="category"]') || text('button.DkEaL');
    const hours = [...document.querySelectorAll('table.eK4R0e tr')].map((row) => {
      const cells = [...row.querySelectorAll('td')].map((cell) => clean(cell.textContent)).filter(Boolean);
      return cells.length >= 2 ? { day: cells[0], hours: cells.slice(1).join(' ') } : null;
    }).filter(Boolean);
    const popularTimeLabels = unique(ariaLabels.filter((label) =>
      /popular times|usually.+busy|currently.+busy|as busy as it gets|\b\d{1,3}% busy\b/i.test(label),
    ));

    return {
      name: text('h1'),
      category,
      rating: ratingLabel ? Number(ratingLabel.match(/[\d.,]+/)?.[0]?.replace(',', '.')) || null : null,
      reviewCount: reviewsLabel ? Number((reviewsLabel.match(/[\d,.]+/)?.[0] || '').replace(/[^\d]/g, '')) || null : null,
      priceLevel: ariaLabels.find((label) => /^(price|price level)\s*:/i.test(label)) || null,
      address: stripLabel(itemText('address'), ['Address']),
      phone: stripLabel(itemText('phone'), ['Phone']),
      website: websiteElement?.href || null,
      plusCode: stripLabel(itemText('oloc'), ['Plus code']),
      openingHours: hours,
      menu: {
        available: menuAvailable,
        url: menuLink?.href || null,
      },
      popularTimeLabels,
    };
  });

  const peakHours = derivePeakHours(details.popularTimeLabels);
  delete details.popularTimeLabels;
  const about = await extractAbout(page);

  const record = {
    ...details,
    peakHours,
    about,
    contact: {
      phone: details.phone,
      website: details.website,
      address: details.address,
    },
    latitude: coordinates?.latitude ?? null,
    longitude: coordinates?.longitude ?? null,
    googleMapsUrl: canonicalUrl,
    query: request.userData.query,
    area: request.userData.area,
    scrapedAt: new Date().toISOString(),
  };

  await pushData(record);
  successfulPlaceCount += 1;
  const elapsedMs = Date.now() - (request.userData.startedAt ?? Date.now());
  requestLog.info(
    `[${successfulPlaceCount}/${queuedPlaceCount}] Scraped in ${formatDuration(elapsedMs)}: ${record.name ?? 'Unknown place'}`,
    {
      category: record.category,
      rating: record.rating,
      reviewCount: record.reviewCount,
      address: record.address,
      searchArea: record.area,
      phone: record.phone,
      website: record.website,
      menu: record.menu,
      openingHours: record.openingHours,
      peakHours: record.peakHours,
      about: record.about,
      url: canonicalUrl,
    },
  );
});

const crawler = new PlaywrightCrawler({
  requestHandler: router,
  headless,
  maxConcurrency: 2,
  maxRequestRetries: 2,
  requestHandlerTimeoutSecs: 90,
  navigationTimeoutSecs: 45,
  preNavigationHooks: [async ({ page, request }) => {
    request.userData.startedAt = Date.now();
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-MY,en;q=0.9' });
  }],
  failedRequestHandler: async ({ request, log: requestLog }) => {
    const elapsedMs = Date.now() - (request.userData.startedAt ?? Date.now());
    if (request.label === 'DETAIL') failedPlaceCount += 1;
    requestLog.error(`Failed after retries in ${formatDuration(elapsedMs)}: ${request.url}`, {
      label: request.label,
      searchArea: request.userData.area,
      retryCount: request.retryCount,
    });
  },
});

const searchRequests = areas.map((searchArea) => ({
  url: buildSearchUrl(query, searchArea),
  label: 'SEARCH',
  uniqueKey: `search:${query}:${searchArea}`,
  userData: { area: searchArea },
}));

log.info(`Searching for "${query}" across ${areas.length} area(s), up to ${maxPlaces} unique places.`);
await crawler.run(searchRequests);

const dataset = await Dataset.getData({ limit: maxPlaces });
await mkdir(outputDir, { recursive: true });
await writeFile(`${outputDir}/restaurants.json`, `${JSON.stringify(dataset.items, null, 2)}\n`, 'utf8');
await writeFile(`${outputDir}/restaurants.csv`, toCsv(dataset.items), 'utf8');
log.info(
  `Finished in ${formatDuration(Date.now() - runStartedAt)}. `
  + `Scraped ${successfulPlaceCount}/${queuedPlaceCount} places successfully; ${failedPlaceCount} failed. `
  + `Exported ${dataset.items.length} records to ${outputDir}/restaurants.json and ${outputDir}/restaurants.csv.`,
);

async function acceptConsentIfShown(page) {
  const candidates = [
    page.getByRole('button', { name: /accept all/i }),
    page.getByRole('button', { name: /agree/i }),
  ];

  for (const candidate of candidates) {
    if (await candidate.first().isVisible().catch(() => false)) {
      await candidate.first().click();
      await page.waitForTimeout(750);
      return;
    }
  }
}

function cleanPlaceUrl(url) {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

function buildSearchUrl(searchQuery, searchArea) {
  return `https://www.google.com/maps/search/${encodeURIComponent(`${searchQuery} in ${searchArea}`)}?hl=en`;
}

async function extractAbout(page) {
  const aboutTab = page.getByRole('tab', { name: /^about\b/i }).first();
  if (await aboutTab.isVisible().catch(() => false)) {
    await aboutTab.click().catch(() => {});
    await page.waitForTimeout(500);
  } else {
    return {};
  }

  return page.locator('div[role="main"]').first().evaluate((main) => {
    const clean = (value) => value?.replace(/[\uE000-\uF8FF]/g, '').replace(/\s+/g, ' ').trim() || null;
    const result = {};

    for (const section of main.querySelectorAll('.iP2t7d')) {
      const heading = clean(section.querySelector('h2')?.textContent);
      if (!heading) continue;

      const items = [...section.querySelectorAll('li')].map((item) => {
        const labelElement = item.querySelector('[aria-label]');
        const ariaLabel = clean(labelElement?.getAttribute('aria-label'));
        const name = clean(labelElement?.textContent || item.textContent);
        const icon = item.querySelector('.google-symbols')?.textContent || '';
        let available = null;

        if (/^(has|serves|offers|accepts|provides|allows|welcomes|good for)\b/i.test(ariaLabel || '')) {
          available = true;
        } else if (/^(no|does not|doesn't|not available)\b/i.test(ariaLabel || '')) {
          available = false;
        } else if (icon.codePointAt(0) === 0xE5CA) {
          available = true;
        } else if (icon.codePointAt(0) === 0xE5CD) {
          available = false;
        }

        return name ? { name, available } : null;
      }).filter(Boolean);

      if (items.length) result[heading] = items;
    }

    return result;
  });
}

function coordinatesFromUrl(url) {
  const match = url.match(/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/)
    || url.match(/!3d(-?\d+(?:\.\d+)?)[^!]*!4d(-?\d+(?:\.\d+)?)/);
  if (!match) return null;
  return { latitude: Number(match[1]), longitude: Number(match[2]) };
}

function positiveInteger(value, fallback) {
  const number = Number.parseInt(value ?? '', 10);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;

  const totalSeconds = milliseconds / 1_000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(2)}s`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

function derivePeakHours(popularTimes) {
  if (!popularTimes?.length) return [];

  const percentages = popularTimes.map((label) => ({
    label,
    percentage: Number(label.match(/(\d{1,3})%/)?.[1] ?? -1),
  }));
  const highestPercentage = Math.max(...percentages.map(({ percentage }) => percentage));
  if (highestPercentage >= 0) {
    return percentages
      .filter(({ percentage }) => percentage === highestPercentage)
      .map(({ label }) => label);
  }

  return popularTimes.filter((label) => /as busy as it gets|very busy|peak/i.test(label));
}

function toCsv(items) {
  const columns = [
    'name', 'category', 'rating', 'reviewCount', 'priceLevel', 'address', 'phone',
    'website', 'plusCode', 'menu', 'openingHours', 'peakHours', 'about', 'contact',
    'latitude', 'longitude', 'googleMapsUrl', 'query', 'area',
    'scrapedAt',
  ];
  const escape = (value) => {
    const string = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `"${string.replaceAll('"', '""')}"`;
  };
  return `${columns.join(',')}\n${items.map((item) => columns.map((column) => escape(item[column])).join(',')).join('\n')}\n`;
}
