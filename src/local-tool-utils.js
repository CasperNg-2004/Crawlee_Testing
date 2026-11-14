import { rename, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { conciseError, sleep } from './common-utils.js';

export async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('Request body is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

export function sendJson(response, status, value) {
  return send(response, status, `${JSON.stringify(value)}\n`, 'application/json; charset=utf-8');
}

export function send(response, status, body, contentType) {
  response.writeHead(status, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  response.end(body);
}

export function openBrowser(url) {
  try {
    const command = process.platform === 'win32'
      ? spawn(process.env.ComSpec || 'cmd.exe', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      : process.platform === 'darwin'
        ? spawn('open', [url], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
    command.unref();
  } catch (error) {
    console.warn(`Could not open the browser automatically: ${conciseError(error)}`);
  }
}

export async function writeFileWithRetry(path, contents, attempts = 10) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await writeFile(temporaryPath, contents, 'utf8');
      await rename(temporaryPath, path);
      return;
    } catch (error) {
      lastError = error;
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (!isRetryableFileError(error) || attempt === attempts) break;
      await sleep(Math.min(150 * attempt, 1_000));
    }
  }
  throw lastError;
}

function isRetryableFileError(error) {
  return ['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES', 'EEXIST'].includes(error?.code);
}

