# cypress-snapshot-reporter

Simple visual snapshot testing for Cypress with pixel diff, optional OCR, and Excel reporting.

## Install

```bash
npm install --save-dev cypress-snapshot-reporter
```

## Quick Setup

### `cypress.config.js`

```js
const { defineConfig } = require("cypress");
const { configSnapshot } = require("cypress-snapshot-reporter/plugin");

module.exports = defineConfig({
  screenshotsFolder: "cypress/snapshots/actual",
  e2e: {
    setupNodeEvents(on, config) {
      config = configSnapshot(on, config, {
        updateBaseline: false,
        snapshotOcrMode: "deferred", // OCR runs AFTER the run (default)
      });
      return config; // REQUIRED — see note below
    },
  },
});
```

### Run tests, then build the OCR report

In the default `"deferred"` OCR mode, `cypress run` performs only the fast pixel
compare and records each diff to `cypress/snapshots/reports/pending-ocr.json`.
OCR then runs in a **separate** Node process afterwards. Chain the two steps in
an npm script:

```json
{
  "scripts": {
    "snapshot:run": "cypress run && node node_modules/cypress-snapshot-reporter/scripts/snapshot-ocr-report.js"
  }
}
```

Or use the bundled bin directly:

```bash
cypress run && npx cypress-snapshot-ocr-report
```

Why deferred? Tesseract's WASM core can crash the process on Node 24 (a
relaxed-SIMD `DotProductSSE` abort). Running OCR after the Cypress run keeps that
crash-prone core out of the Cypress process. OCR stays fully enabled — the post-
run script pins a safe WASM core and wraps every recognition in `try/catch`, so a
failing image degrades gracefully instead of failing the pipeline.

To keep the old inline behaviour (OCR during the run), set
`snapshotOcrMode: "inline"`.

> **You MUST `return config`.** `configSnapshot` redirects screenshots to an
> internal temp folder by setting `config.screenshotsFolder`. Cypress only
> applies that change if your `setupNodeEvents` returns the (possibly modified)
> `config` object. If you forget, Cypress writes screenshots to the default
> `cypress/screenshots/` folder and you may see errors like
> `Screenshot not found: "<name>"`. Always assign the return value back and
> return it:
>
> ```js
> setupNodeEvents(on, config) {
>   config = configSnapshot(on, config);
>   return config;
> }
> ```
>
> (The plugin also falls back to searching `cypress/screenshots/` and uses the
> exact saved screenshot path, so it is resilient — but returning `config`
> keeps captures out of your repo's default screenshots folder.)

### Do not register your own `before:browser:launch`

`configSnapshot` registers a `before:browser:launch` handler to size the
browser window. Cypress keeps only **one** such handler, so adding your own in
`setupNodeEvents` will silently override the plugin's and break window sizing.
Set the window size with the `browserWidth` / `browserHeight` options instead:

```js
configSnapshot(on, config, { browserWidth: 1280, browserHeight: 800 });
```

### `cypress/support/e2e.js`

```js
import "cypress-snapshot-reporter/commands";
```

## Use In Test

```js
cy.matchSnapshot("Report/Home");
```

## Main Options

`configSnapshot(on, config, options)`

- `baselineDir` (default: `cypress/snapshots/baseline`)
- `actualDir` (default: `cypress/snapshots/actual`)
- `diffDir` (default: `cypress/snapshots/diff`)
- `excelFile` (default: `cypress/snapshots/reports/diff-report.xlsx`)
- `pendingOcrFile` (default: `cypress/snapshots/reports/pending-ocr.json`) manifest of diffs awaiting OCR (deferred mode)
- `snapshotOcrMode` (default: `"deferred"`) `"deferred"` runs OCR after the run via `scripts/snapshot-ocr-report.js`; `"inline"` runs it during the run
- `updateBaseline` (default: `false`) auto-update baseline after compare
- `browserWidth` (default: `1280`) window width via `before:browser:launch`
- `browserHeight` (default: `800`) window height via `before:browser:launch`
- `screenshotTimeout` (default: `5000`) ms to wait for the captured PNG

`cy.matchSnapshot(name, options)`

- `threshold` (default: `0.1`)
- `failOnDiff` (default: `false`)
- `runOcr` (default: `true`)
- `ocrMode` (optional) per-call override of `snapshotOcrMode` (`"deferred"` | `"inline"`)
- `updateBaseline` (default: `false`) per-call override
- `diffDir` (optional) per-call diff path for reporter link
- `capture` (default: `"fullPage"`) Cypress capture mode (`"fullPage"`,
  `"viewport"`, or `"runner"`)
- `screenshotTimeout` (optional) per-call override

### Capturing a single element

`matchSnapshot` accepts an optional chained subject. When you chain it off an
element, only that element is captured (instead of the full page). This is
useful on very large viewports where full-page stitching can silently produce
no file:

```js
cy.get(".chart").matchSnapshot("Dashboard/Chart");
```

## Baseline Update

Manual baseline update:

```js
cy.task("updateBaseline", { name: "Report/Home" });
```

Auto baseline update (global):

```js
configSnapshot(on, config, { updateBaseline: true });
```

## Output Folders

```text
cypress/snapshots/
  baseline/   (baseline)
  actual/     (latest run)
  diff/       (generated only when real diff exists)
  reports/    (diff-report.xlsx, pending-ocr.json)
```

## Requirements

- Node.js >= 16
- Cypress >= 13
