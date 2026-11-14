import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  createPipelineRun,
  findLatestPipelineFile,
  outputFile,
  outputRunForFile,
} from '../src/output-paths.js';

test('creates a numbered pipeline with all three stages', async () => {
  const root = await mkdtemp(join(process.cwd(), 'test', 'output-layout-'));
  try {
    const pipeline = await createPipelineRun(root);
    assert.equal(pipeline, join(root, 'Running#1'));
    const scraper = join(pipeline, 'scraper');
    const jsonPath = outputFile(scraper, 'json', 'restaurants.json');
    await writeFile(jsonPath, '[]\n', 'utf8');
    assert.equal(outputRunForFile(jsonPath), scraper);
    assert.equal(
      await findLatestPipelineFile(root, 'scraper/json/restaurants.json'),
      jsonPath,
    );
    for (const stage of ['scraper', 'photo-classification', 'photo-analysis']) {
      assert.equal((await stat(join(pipeline, stage))).isDirectory(), true);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('increments the run number without overwriting an earlier pipeline', async () => {
  const root = await mkdtemp(join(process.cwd(), 'test', 'output-layout-'));
  try {
    const first = await createPipelineRun(root);
    const second = await createPipelineRun(root);
    assert.equal(first, join(root, 'Running#1'));
    assert.equal(second, join(root, 'Running#2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
