import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createOutputRun,
  findLatestOutputFile,
  outputFile,
  outputRunForFile,
} from '../src/output-paths.js';

test('creates local date/time runs with typed output folders', async () => {
  const root = await mkdtemp(join(process.cwd(), 'test', 'output-layout-'));
  try {
    const run = await createOutputRun(root, new Date(2026, 10, 14, 9, 8, 7));
    assert.equal(run, join(root, '2026-11-14', '09-08-07'));
    const jsonPath = outputFile(run, 'json', 'restaurants.json');
    await writeFile(jsonPath, '[]\n', 'utf8');
    assert.equal(outputRunForFile(jsonPath), run);
    assert.equal(await findLatestOutputFile(root, 'json/restaurants.json'), jsonPath);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('adds a collision suffix without overwriting a run', async () => {
  const root = await mkdtemp(join(process.cwd(), 'test', 'output-layout-'));
  try {
    const date = new Date(2026, 10, 14, 9, 8, 7);
    const first = await createOutputRun(root, date);
    const second = await createOutputRun(root, date);
    assert.equal(first, join(root, '2026-11-14', '09-08-07'));
    assert.equal(second, join(root, '2026-11-14', '09-08-07-01'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
