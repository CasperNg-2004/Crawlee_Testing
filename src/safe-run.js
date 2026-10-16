import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const resume = process.argv.includes('--resume');
const batchSize = positiveInteger(process.env.SAFE_BATCH_SIZE, 4);
const restartDelayMs = positiveInteger(process.env.SAFE_RESTART_DELAY_MS, 5_000);
const maxConsecutiveFailures = positiveInteger(process.env.SAFE_MAX_CONSECUTIVE_FAILURES, 3);
const maxPlaces = positiveInteger(process.env.MAX_PLACES, 1000);
const queries = (process.env.QUERIES?.trim() || process.env.QUERY?.trim() || 'restaurant')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const areas = (process.env.AREAS?.trim() || process.env.AREA?.trim() || 'Kuala Lumpur, Malaysia')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean);
const directPlaceCount = (process.env.PLACE_URLS?.trim() || '')
  .split('|')
  .map((value) => value.trim())
  .filter(Boolean)
  .slice(0, maxPlaces)
  .length;
const plannedDetailCount = directPlaceCount || maxPlaces;
const discoveryRequestCount = directPlaceCount ? 0 : areas.length * queries.length;
const plannedRequestCount = discoveryRequestCount + plannedDetailCount;
const storageDir = resolve(process.env.CRAWLEE_STORAGE_DIR?.trim() || 'storage');

let freshRun = !resume;
let consecutiveFailures = 0;
let lastExitCode = 0;

console.log(
  `[safe-run] ${freshRun ? 'Starting a fresh scrape' : 'Resuming the existing scrape'} `
  + `in batches of ${batchSize} restaurant(s).`,
);
console.log('[safe-run] Chrome will close between batches to release memory and the profile lock.');

while (true) {
  const before = freshRun ? emptyState() : await readCrawlState(storageDir);

  if (!freshRun && before.queue.total === 0) {
    throw new Error('No existing Crawlee request queue was found. Use `npm run start:safe` for a fresh run.');
  }

  if (!freshRun && before.queue.pending === 0) {
    console.log(
      `[safe-run] Queue is already complete (${before.queue.handled}/${before.queue.total} requests).`,
    );
    break;
  }

  const processedBefore = freshRun ? 0 : Math.max(before.processed, before.queue.handled);
  const knownTotal = freshRun ? plannedRequestCount : before.queue.total;
  // The first process completes discovery and seeds every selected detail URL.
  // Detail scraping starts in the next process so Crawlee's request cap cannot
  // truncate queue insertion to only one batch.
  const firstBatchAllowance = discoveryRequestCount
    || Math.min(batchSize, plannedDetailCount);
  const target = freshRun
    ? firstBatchAllowance
    : Math.min(knownTotal, processedBefore + batchSize);

  console.log(
    `[safe-run] Launching Chrome batch up to cumulative request ${target}`
    + `${knownTotal ? `/${knownTotal}` : ''}.`,
  );

  lastExitCode = await runMain({
    purgeOnStart: freshRun,
    maxRequestsPerCrawl: target,
  });

  const after = await readCrawlState(storageDir);
  const madeProgress = after.queue.handled > before.queue.handled || after.processed > before.processed;

  if (lastExitCode === 0) {
    consecutiveFailures = 0;
  } else {
    consecutiveFailures += 1;
    console.warn(
      `[safe-run] Scraper process exited with code ${lastExitCode}. `
      + `Progress is preserved; restart attempt ${consecutiveFailures}/${maxConsecutiveFailures}.`,
    );
  }

  if (after.queue.total === 0) {
    if (lastExitCode === 0) {
      throw new Error('The scraper exited normally but did not create a request queue.');
    }
    if (consecutiveFailures >= maxConsecutiveFailures) {
      throw new Error(
        `Stopped after ${maxConsecutiveFailures} consecutive startup failures. `
        + 'No request queue was created and no scrape progress was lost.',
      );
    }
    // A profile lock can prevent the first Chrome process from opening before
    // Crawlee initializes storage. Keep first-run semantics for the retry.
    freshRun = true;
    console.log(`[safe-run] Waiting ${Math.round(restartDelayMs / 1000)}s before retrying startup.`);
    await delay(restartDelayMs);
    continue;
  }

  freshRun = false;

  console.log(
    `[safe-run] Progress: ${after.queue.handled}/${after.queue.total} requests handled; `
    + `${after.queue.pending} pending.`,
  );

  if (after.queue.total > 0 && after.queue.pending === 0) {
    if (lastExitCode !== 0) {
      console.log('[safe-run] Running a final export checkpoint after the interrupted process.');
      const checkpointCode = await runMain({
        purgeOnStart: false,
        maxRequestsPerCrawl: Math.max(after.processed, after.queue.handled),
      });
      if (checkpointCode !== 0) {
        throw new Error(`Final export checkpoint exited with code ${checkpointCode}.`);
      }
    }
    break;
  }

  if (!madeProgress && lastExitCode === 0) {
    throw new Error(
      'The safe runner made no queue progress even though the scraper exited normally. '
      + 'The storage statistics may be inconsistent; the queue was preserved.',
    );
  }

  if (consecutiveFailures >= maxConsecutiveFailures) {
    throw new Error(
      `Stopped after ${maxConsecutiveFailures} consecutive scraper-process failures. `
      + 'The queue and completed dataset records remain available for `npm run resume:safe`.',
    );
  }

  console.log(`[safe-run] Waiting ${Math.round(restartDelayMs / 1000)}s before restarting Chrome.`);
  await delay(restartDelayMs);
}

const finalState = await readCrawlState(storageDir);
console.log(
  `[safe-run] Complete. ${finalState.queue.handled}/${finalState.queue.total} requests handled. `
  + 'Final outputs are in the configured output directory.',
);

function runMain({ purgeOnStart, maxRequestsPerCrawl }) {
  return new Promise((resolveExit) => {
    const child = spawn(
      process.execPath,
      ['--env-file=.env', 'src/main.js'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          CRAWLEE_PURGE_ON_START: purgeOnStart ? '1' : '0',
          MAX_REQUESTS_PER_CRAWL: String(maxRequestsPerCrawl),
        },
      },
    );

    child.once('error', (error) => {
      console.error(`[safe-run] Could not start the scraper process: ${error.message}`);
      resolveExit(1);
    });
    child.once('exit', (code, signal) => {
      if (signal) console.warn(`[safe-run] Scraper process ended after signal ${signal}.`);
      resolveExit(code ?? 1);
    });
  });
}

async function readCrawlState(root) {
  const queueDir = resolve(root, 'request_queues', 'default');
  const statsPath = resolve(root, 'key_value_stores', 'default', 'SDK_CRAWLER_STATISTICS_0.json');
  const queue = { total: 0, handled: 0, pending: 0 };

  try {
    const entries = await readdir(queueDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      const wrapper = JSON.parse(await readFile(resolve(queueDir, entry.name), 'utf8'));
      const request = typeof wrapper.json === 'string' ? JSON.parse(wrapper.json) : wrapper;
      queue.total += 1;
      if (request.handledAt) queue.handled += 1;
      else queue.pending += 1;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  let processed = queue.handled;
  try {
    const stats = JSON.parse(await readFile(statsPath, 'utf8'));
    processed = (Number(stats.requestsFinished) || 0) + (Number(stats.requestsFailed) || 0);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  return { queue, processed };
}

function emptyState() {
  return {
    queue: { total: 0, handled: 0, pending: 0 },
    processed: 0,
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
