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
      });
      return config; // REQUIRED — see note below
    },
  },
});
```

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
- `updateBaseline` (default: `false`) auto-update baseline after compare
- `browserWidth` (default: `1280`) window width via `before:browser:launch`
- `browserHeight` (default: `800`) window height via `before:browser:launch`
- `screenshotTimeout` (default: `5000`) ms to wait for the captured PNG

`cy.matchSnapshot(name, options)`

- `threshold` (default: `0.1`)
- `failOnDiff` (default: `false`)
- `runOcr` (default: `true`)
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
  reports/    (diff-report.xlsx)
```

## Requirements

- Node.js >= 16
- Cypress >= 13
