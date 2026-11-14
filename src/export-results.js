import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { exportRestaurantsToExcel } from './excel-export.js';
import { flattenPhotoList, photoListToCsv } from './photo-export.js';
import {
  ensureOutputTypes,
  findLatestOutputFile,
  findLatestPipelineFile,
  outputFile,
  outputRunForFile,
} from './output-paths.js';

const [mode, inputArgument, outputArgument] = process.argv.slice(2);
if (!['excel', 'photos'].includes(mode)) {
  throw new Error('Usage: node src/export-results.js <excel|photos> [restaurants.json] [output]');
}

const inputEnvironment = mode === 'excel'
  ? process.env.EXCEL_EXPORT_INPUT?.trim()
  : process.env.PHOTO_LIST_INPUT?.trim();
const inputPath = inputArgument || inputEnvironment
  ? resolve(inputArgument || inputEnvironment)
  : await findLatestPipelineFile(process.env.OUTPUT_ROOT?.trim() || 'output', [
    'scraper/json/restaurants.json',
    'scraper/json/restaurants-classified.json',
  ]) || await findLatestOutputFile('output/scraper', [
    'json/restaurants.json',
    'json/restaurants-classified.json',
    'restaurants.json',
  ]);
if (!inputPath) throw new Error('No scraper restaurants.json output was found.');

const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
const records = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

if (mode === 'excel') {
  const outputPath = resolve(
    outputArgument
    || process.env.EXCEL_EXPORT_OUTPUT?.trim()
    || outputFile(outputRunForFile(inputPath), 'xlsx', 'restaurants.xlsx'),
  );
  const counts = await exportRestaurantsToExcel(records, outputPath);
  console.log(`Exported ${records.length} place(s) to ${outputPath}.`);
  console.log(`Workbook rows: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(', ')}.`);
} else {
  const outputDir = await ensureOutputTypes(resolve(
    outputArgument
    || process.env.PHOTO_LIST_OUTPUT_DIR?.trim()
    || outputRunForFile(inputPath),
  ));
  const rows = flattenPhotoList(records);
  await writeFile(outputFile(outputDir, 'json', 'photo-list.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  await writeFile(outputFile(outputDir, 'csv', 'photo-list.csv'), photoListToCsv(rows), 'utf8');
  const missingDates = rows.filter((row) => !row.uploadDate).length;
  const missingLinks = rows.filter((row) => !row.fullSizeImageUrl).length;
  console.log(`Exported ${rows.length} photo-tab rows from ${inputPath}.`);
  console.log(`Missing upload dates: ${missingDates}; missing full-size links: ${missingLinks}.`);
  console.log(`Output: ${outputDir}`);
}
