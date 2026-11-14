# Troubleshooting, runtime, and limitations

[Documentation index](README.md) · [Setup and login](setup-and-login.md) · [Scraper guide](scraper-guide.md)

## `Unknown process listing header: WorkingSetSiz`

Keep the repository's Windows compatibility settings:

```dotenv
CRAWLEE_SYSTEM_INFO_V2=true
COLUMNS=200
```

Use the supported Node.js version and current dependencies. The source includes
the Crawlee Windows process-header compatibility fix.

## Chrome crashes or memory grows

- Use `npm run start:safe`.
- Keep `SAFE_BATCH_SIZE=4` or reduce it to 2.
- Keep `PHOTO_DATE_CONCURRENCY=1`.
- Do not run login or another scraper with the same profile.
- Reduce photo tabs or disable photos only for a diagnostic test.
- Resume the same preserved queue with `npm run resume:safe`.

Slower scrolling may reduce page-loading pressure but does not remove Chrome's
base memory requirements. GPU memory cannot replace system RAM for browser pages.

## Chrome profile is already in use

Close every project Chrome window and stop any login or scraper using the
profile. Wait for the lock to release, then run again. Do not delete
`.chrome-profile` merely to clear a lock.

## Maps asks for sign-in or hides data

Run `npm run login`, sign in manually, confirm the full Maps UI, and close the
dedicated Chrome windows. Keep `REQUIRE_GOOGLE_SIGN_IN=true` for production.

If Google shows unusual traffic or CAPTCHA, stop. Do not record remaining places
as `none`; resolve the condition and resume.

## Fewer places than `MAX_PLACES`

Discovery depends on unique Google results. Increase
`MAX_CANDIDATES_PER_AREA`, add relevant areas, and allow more scrolling. Direct
place IDs are more deterministic than area discovery.

## Safe mode appears capped at four

`SAFE_BATCH_SIZE=4` is the number processed before Chrome restarts, not the final
place limit. Safe mode continues until the queue is empty unless a safety stop or
repeated terminal failures occur.

## Typed menu is missing or incomplete

Check `menuScrape.tabExists`, status, attempts, and item count. A loaded Menu tab
with no items is different from a failed page. Validate Google DOM changes with
a one-place run in separate output and storage directories.

## Fewer photos than requested

Google may expose fewer unique non-video images than a tab limit. Check each
tab's status. `none` requires a loaded tab with confirmed absence; load failures
must remain `failed`.

## Photo analysis was interrupted

```powershell
npm run analyze:photos:resume
```

Do not change the OCR engine while resuming. Completed restaurant checkpoints
are preserved.

## OCR is empty or accuracy is `n/a`

- `ocr: null`: CLIP did not classify the image as a menu.
- `ocr.status: none`: PaddleOCR ran but found no usable text.
- `ocr.status: failed`: recognition failed.
- Character accuracy is `n/a` until corrected `expectedOcrText` exists.

Use `npm run label:ocr` to create OCR ground truth. Category labels alone are
not enough.

## CSV cannot be saved

Close the CSV in Excel or another program. Windows may lock the file. The local
labellers retry atomic saves but cannot replace a file held indefinitely.

## Brand fields remain `null`

This is expected when `config/malaysia-chain-counts.json` has no verified entry
or alias. Never infer outlet counts from search-result counts.

## Observed runtime

Runtime depends on Google latency, photos, upload dates, reviews, and OCR. The
current 20-place output recorded:

- Main safe scraper: about 1 hour 27 minutes
- 600-photo classification and PaddleOCR: about 1 hour 6 minutes
- Structured parsing: about 1.2 seconds
- Full timestamp span to workbook: about 4 hours 34 minutes, including gaps and
  manual stages

The optimized one-place path has completed in 3 minutes 18 seconds including
Chrome startup, but Google latency prevents a repeatable under-four-minute
guarantee.

## Known gaps

- Menu-photo recall is 96.15%, below the 98% target.
- OCR character accuracy has not been measured on corrected text.
- Parser correct/wrong/missed price metrics have not been measured.
- The parser retains many ambiguous and unpaired price lines.
- Matching coverage and price agreement remain estimated without ground truth.
- Live client acceptance comparisons still need reference exports.

## Client inputs still required

1. Final production place IDs or supported URLs.
2. KL typed-menu acceptance places and Apify section/item/price export.
3. Ten-shop photo reference with per-tab IDs, counts, and upload dates.
4. Confirmation of what the under-four-minute target includes.
5. Verified Malaysia outlet counts and brand aliases.
6. Final place count, photo tabs, output location, and visible fallback policy.
