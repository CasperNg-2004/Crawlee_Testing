import { mkdir, readdir, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const OUTPUT_TYPES = ['json', 'csv', 'xlsx', 'other'];
export const PIPELINE_STAGES = ['scraper', 'photo-classification', 'photo-analysis'];
const PIPELINE_RUN_PATTERN = /^Running#(\d+)$/i;

export function outputTimestamp(date = new Date()) {
  const part = (value) => String(value).padStart(2, '0');
  return {
    date: `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())}`,
    time: `${part(date.getHours())}-${part(date.getMinutes())}-${part(date.getSeconds())}`,
  };
}

export async function createOutputRun(baseDirectory, date = new Date()) {
  const base = resolve(baseDirectory);
  const timestamp = outputTimestamp(date);
  const dateDirectory = join(base, timestamp.date);
  await mkdir(dateDirectory, { recursive: true });

  for (let suffix = 0; suffix < 100; suffix += 1) {
    const name = suffix ? `${timestamp.time}-${String(suffix).padStart(2, '0')}` : timestamp.time;
    const runDirectory = join(dateDirectory, name);
    try {
      await mkdir(runDirectory, { recursive: false });
      return ensureOutputTypes(runDirectory);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not create a unique output run under ${dateDirectory}.`);
}

export async function createPipelineRun(baseDirectory) {
  const base = resolve(baseDirectory);
  await mkdir(base, { recursive: true });
  const existing = await readdir(base, { withFileTypes: true }).catch(() => []);
  const highest = existing.reduce((maximum, entry) => {
    if (!entry.isDirectory()) return maximum;
    const match = entry.name.match(PIPELINE_RUN_PATTERN);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);

  for (let number = highest + 1; number < highest + 101; number += 1) {
    const runDirectory = join(base, `Running#${number}`);
    try {
      await mkdir(runDirectory, { recursive: false });
      await Promise.all(PIPELINE_STAGES.map((stage) => mkdir(join(runDirectory, stage), { recursive: true })));
      await ensureOutputTypes(join(runDirectory, 'scraper'));
      await ensureOutputTypes(join(runDirectory, 'photo-classification'));
      return runDirectory;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`Could not create a unique numbered run under ${base}.`);
}

export async function ensurePipelineStage(runDirectory, stage) {
  if (!PIPELINE_STAGES.includes(stage)) throw new Error(`Unknown pipeline stage: ${stage}`);
  const stageDirectory = join(resolve(runDirectory), stage);
  if (stage === 'photo-analysis') {
    await mkdir(stageDirectory, { recursive: true });
    return stageDirectory;
  }
  return ensureOutputTypes(stageDirectory);
}

export function pipelineRunForFile(filePath) {
  let current = resolve(filePath);
  while (true) {
    if (PIPELINE_RUN_PATTERN.test(basename(current))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export async function listPipelineRuns(baseDirectory) {
  const root = resolve(baseDirectory);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && PIPELINE_RUN_PATTERN.test(entry.name))
    .map((entry) => ({
      path: join(root, entry.name),
      number: Number(entry.name.match(PIPELINE_RUN_PATTERN)[1]),
    }))
    .sort((left, right) => right.number - left.number)
    .map((entry) => entry.path);
}

export async function findLatestPipelineRun(baseDirectory, relativeFilenames = []) {
  const filenames = Array.isArray(relativeFilenames) ? relativeFilenames : [relativeFilenames];
  for (const runDirectory of await listPipelineRuns(baseDirectory)) {
    if (!filenames.length) return runDirectory;
    for (const filename of filenames) {
      if (await pathExists(join(runDirectory, filename))) return runDirectory;
    }
  }
  return null;
}

export async function findLatestPipelineFile(baseDirectory, relativeFilenames) {
  const filenames = Array.isArray(relativeFilenames) ? relativeFilenames : [relativeFilenames];
  const runDirectory = await findLatestPipelineRun(baseDirectory, filenames);
  if (!runDirectory) return null;
  for (const filename of filenames) {
    const path = join(runDirectory, filename);
    if (await pathExists(path)) return path;
  }
  return null;
}

export async function ensureOutputTypes(runDirectory) {
  const root = resolve(runDirectory);
  await mkdir(root, { recursive: true });
  await Promise.all(OUTPUT_TYPES.map((type) => mkdir(join(root, type), { recursive: true })));
  return root;
}

export function outputFile(runDirectory, type, filename) {
  if (!OUTPUT_TYPES.includes(type)) throw new Error(`Unknown output type: ${type}`);
  return join(resolve(runDirectory), type, filename);
}

export function outputRunForFile(filePath) {
  const parent = dirname(resolve(filePath));
  return OUTPUT_TYPES.includes(basename(parent).toLowerCase()) ? dirname(parent) : parent;
}

export async function listOutputRuns(baseDirectory) {
  const root = resolve(baseDirectory);
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const child = join(root, entry.name);
    if (/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
      const times = await readdir(child, { withFileTypes: true }).catch(() => []);
      for (const time of times) {
        if (time.isDirectory()) candidates.push(join(child, time.name));
      }
    } else {
      // Backward-compatible discovery for the earlier one-folder timestamp layout.
      candidates.push(child);
    }
  }

  const ranked = await Promise.all(candidates.map(async (path) => ({
    path,
    modified: await stat(path).then((value) => value.mtimeMs).catch(() => 0),
  })));
  return ranked.sort((left, right) => right.modified - left.modified).map((entry) => entry.path);
}

export async function findLatestOutputRun(baseDirectory, relativeFilenames) {
  const filenames = Array.isArray(relativeFilenames) ? relativeFilenames : [relativeFilenames];
  for (const runDirectory of await listOutputRuns(baseDirectory)) {
    for (const filename of filenames) {
      if (await pathExists(join(runDirectory, filename))) return runDirectory;
    }
  }
  return null;
}

export async function findLatestOutputFile(baseDirectory, relativeFilenames) {
  const filenames = Array.isArray(relativeFilenames) ? relativeFilenames : [relativeFilenames];
  const runDirectory = await findLatestOutputRun(baseDirectory, filenames);
  if (!runDirectory) return null;
  for (const filename of filenames) {
    const path = join(runDirectory, filename);
    if (await pathExists(path)) return path;
  }
  return null;
}

async function pathExists(path) {
  return stat(path).then(() => true).catch(() => false);
}
