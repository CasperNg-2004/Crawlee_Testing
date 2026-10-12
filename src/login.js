import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const chromeProfileDir = resolve(process.env.CHROME_PROFILE_DIR?.trim() || '.chrome-profile');
const chromePath = findChromeExecutable();

if (!chromePath) {
  throw new Error('Google Chrome was not found. Set CHROME_PATH in .env to the full path of chrome.exe.');
}

await mkdir(chromeProfileDir, { recursive: true });

const chrome = spawn(chromePath, [
  `--user-data-dir=${chromeProfileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
  'https://www.google.com/maps?hl=en',
], {
  detached: true,
  stdio: 'ignore',
});
chrome.unref();

console.log(`\nOpened normal Google Chrome with the dedicated profile:\n${chromeProfileDir}`);
console.log('Sign into Google and confirm that Maps shows the Menu tab.');
console.log('Then close every Chrome window belonging to this dedicated profile.');

const readline = createInterface({ input, output });
await readline.question('After closing the dedicated Chrome window, press Enter to continue... ');
readline.close();

console.log('The dedicated Chrome profile is ready. Run `npm start` to scrape with it.');

function findChromeExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    process.env.PROGRAMFILES && `${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env['PROGRAMFILES(X86)'] && `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
    process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
  ].filter(Boolean);

  return candidates.find((candidate) => existsSync(candidate)) || null;
}
