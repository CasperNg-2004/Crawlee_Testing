# Setup and Google login

[Documentation index](README.md) · [Project overview](../README.md)

## Requirements

- Windows with PowerShell
- Node.js 20 or newer
- Python 3.12 for the validated PaddleOCR environment
- Google Chrome
- Stable access to Google Maps and Google-hosted photo URLs
- Disk space for npm packages, `.chrome-profile`, model caches, and outputs

The validated configuration runs CLIP and PaddleOCR on the CPU. More RAM reduces
Windows swapping and Chrome crashes; faster internet mainly improves Maps page,
review, and image loading.

## Install once

From the repository root:

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
npm run setup:paddleocr
```

Skip `Copy-Item` if a configured `.env` already exists. PaddleOCR is installed
inside `.venv-paddleocr` and does not modify the Node.js dependency set.

The first photo-analysis run downloads the CLIP model and official PaddleOCR
models. Later runs reuse the Hugging Face, PaddleOCR, and optional Tesseract
caches.

## Sign in to Google Maps

```powershell
npm run login
```

1. Sign in to the Google account used for Maps.
2. Open a Maps place and confirm that Menu, Reviews, and Photos are visible.
3. Close every Chrome window opened by the login command.
4. Return to PowerShell and press Enter if requested.

The login is normally needed once. Run it again only when Google expires the
session or the scraper reports a signed-out safety stop.

The dedicated session is stored in `.chrome-profile`. It is excluded from Git,
contains sensitive account data, and must never be shared. Login and scraping
must not run simultaneously because only one process can hold the profile lock.

## Technologies and external dependencies

| Component | Purpose |
| --- | --- |
| Crawlee | Request queues, retries, browser lifecycle, and crawl statistics. |
| Playwright and Chrome | Control Google Maps and extract its dynamic UI. |
| Hugging Face Transformers.js | Load and run `Xenova/clip-vit-base-patch32`. |
| PaddlePaddle and PaddleOCR | Detect and recognize positioned menu text locally. |
| Sharp | Decode, resize, sharpen, and annotate images. |
| ExcelJS | Produce scraper workbooks and `menu-check.xlsx`. |
| Python `SequenceMatcher` | Deterministic fuzzy name validation; it does not assign prices. |
| Local browser tools | Manual photo labels, OCR corrections, and unresolved-price review. |
| Tesseract.js | Historical fallback; PaddleOCR is the current default. |

Google Maps supplies the business data and photos. Hugging Face and PaddleOCR
are contacted for the first model download. The project does not use OpenAI,
Claude, Gemini, Google Places API, a paid OCR API, cloud storage, or an external
database.

## Verify the installation

```powershell
node --check src/main.js
node --check src/safe-run.js
npm test
```

Continue with the [scraper guide](scraper-guide.md).
