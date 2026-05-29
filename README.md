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
      configSnapshot(on, config, {
        updateBaseline: false,
      });
      return config;
    },
  },
});
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
- `browserWidth` (default: `6400`)
- `browserHeight` (default: `4400`)

`cy.matchSnapshot(name, options)`

- `threshold` (default: `0.1`)
- `failOnDiff` (default: `false`)
- `runOcr` (default: `true`)
- `updateBaseline` (default: `false`) per-call override
- `diffDir` (optional) per-call diff path for reporter link

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
  baseline/   (commit to git)
  actual/     (latest run)
  diff/       (generated only when real diff exists)
  reports/    (diff-report.xlsx)
```

## Requirements

- Node.js >= 16
- Cypress >= 13
