import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { exportRestaurantsToExcel } from './excel-export.js';

const inputPath = resolve(process.argv[2] || process.env.EXCEL_EXPORT_INPUT?.trim()
  || 'output/restaurants.json');
const outputPath = resolve(process.argv[3] || process.env.EXCEL_EXPORT_OUTPUT?.trim()
  || join(dirname(inputPath), 'restaurants.xlsx'));
const parsed = JSON.parse(await readFile(inputPath, 'utf8'));
const records = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
const counts = await exportRestaurantsToExcel(records, outputPath);

console.log(`Exported ${records.length} place(s) to ${outputPath}.`);
console.log(`Workbook rows: ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(', ')}.`);
