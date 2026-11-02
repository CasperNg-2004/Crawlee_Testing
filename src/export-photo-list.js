import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { flattenPhotoList, photoListToCsv } from './photo-export.js';

const inputPath = resolve(process.argv[2] || process.env.PHOTO_LIST_INPUT?.trim()
  || 'output/restaurants.json');
const outputDir = resolve(process.argv[3] || process.env.PHOTO_LIST_OUTPUT_DIR?.trim()
  || dirname(inputPath));
const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
const records = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
const rows = flattenPhotoList(records);

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, 'photo-list.json'), `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
await writeFile(join(outputDir, 'photo-list.csv'), photoListToCsv(rows), 'utf8');

const missingDates = rows.filter((row) => !row.uploadDate).length;
const missingLinks = rows.filter((row) => !row.fullSizeImageUrl).length;
console.log(`Exported ${rows.length} photo-tab rows from ${inputPath}.`);
console.log(`Missing upload dates: ${missingDates}; missing full-size links: ${missingLinks}.`);
console.log(`Output: ${outputDir}`);
