# cypress-snapshot-reporter

A Cypress plugin for **visual snapshot testing** with:

- Pixel-level diff using [pixelmatch](https://github.com/mapbox/pixelmatch)
- Side-by-side diff image: `[ Baseline | Diff | Actual ]`
- Severity classification: `Critical / High / Medium / Low`
- OCR on changed regions using [Tesseract.js](https://github.com/naptha/tesseract.js) (**offline** — model bundled)
- Table detection and cell-level value comparison
- Excel report (`diff-report.xlsx`) with colour-coded severity rows
- Mochawesome HTML report integration

Works fully **offline** — no data is ever sent to external servers.

---

## Installation

```bash
npm install --save-dev cypress-snapshot-reporter
```

---

## Setup

### 1. `cypress.config.js`

```js
const { defineConfig } = require("cypress");
const { configSnapshot } = require("cypress-snapshot-reporter/plugin");

module.exports = defineConfig({
  screenshotsFolder: "cypress/snapshots/actual",
  e2e: {
    setupNodeEvents(on, config) {
      configSnapshot(on, config);
      return config;
    },
  },
});
```

### 2. `cypress/support/e2e.js`

```js
import "cypress-snapshot-reporter/commands";
```

---

## Usage in tests

```js
cy.matchSnapshot("ReportName/SectionName_2025-07-31");
```

That single line:
1. Takes a full-page screenshot → `cypress/snapshots/actual/`
2. On first run: saves to `cypress/snapshots/baseline/` (no diff), keeps `actual`
3. On subsequent runs: diffs against baseline using pixelmatch
4. If diff found: writes side-by-side PNG to `cypress/snapshots/diff/`
5. If no diff/noise-only: no diff image is kept for that snapshot
6. Runs OCR on each changed region → compares baseline vs actual text
7. Appends results to `cypress/snapshots/reports/diff-report.xlsx`
8. Attaches severity + diff image + OCR text to Mochawesome report

---

## Options

### `configSnapshot(on, config, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `baselineDir` | string | `cypress/snapshots/baseline` | Where golden images are stored |
| `actualDir` | string | `cypress/snapshots/actual` | Where run screenshots are saved |
| `diffDir` | string | `cypress/snapshots/diff` | Where diff composites are written |
| `excelFile` | string | `cypress/snapshots/reports/diff-report.xlsx` | Excel report path |
| `updateBaseline` | boolean | `false` | Auto-promote `actual` to baseline after compare |
| `browserWidth` | number | `6400` | Electron window width |
| `browserHeight` | number | `4400` | Electron window height |

```js
configSnapshot(on, config, {
  baselineDir:   "tests/snapshots/baseline",
  actualDir:     "tests/snapshots/actual",
  diffDir:       "tests/snapshots/diff",
  excelFile:     "reports/visual-diff.xlsx",
  updateBaseline: false,
  browserWidth:  1920,
  browserHeight: 1080,
});
```

### `cy.matchSnapshot(name, options?)`

| Option | Type | Default | Description |
|---|---|---|---|
| `threshold` | number | `0.1` | Pixelmatch sensitivity (0–1). Lower = more sensitive |
| `failOnDiff` | boolean | `false` | Fail the test when pixels differ |
| `runOcr` | boolean | `true` | Run OCR + write Excel when diff is found |
| `updateBaseline` | boolean | `false` | Auto-promote current actual to baseline after compare |
| `diffDir` | string | from plugin options | Diff image path used in reporter context |

```js
cy.matchSnapshot("Overview_2025-07-31", {
  threshold:   0.05,   // very sensitive
  failOnDiff:  true,   // fail test on any diff
  runOcr:      false,  // skip OCR for this snapshot
});
```

---

## Severity levels

Severity is based on the percentage of pixels that changed:

| Level | Threshold | Example |
|---|---|---|
| **Critical** | > 2.0% | Whole table or page layout changed |
| **High** | > 0.5% | Multi-row section changed |
| **Medium** | > 0.05% | A few cells changed |
| **Low** | > 0% | A single value changed (e.g. `1.26 → 1.28`) |

---

## Excel report columns

| Column | Description |
|---|---|
| Severity | Colour-coded badge (Critical/High/Medium/Low) |
| Snapshot Name | Name passed to `cy.matchSnapshot()` |
| Content Type | `Table` or `Text` (auto-detected) |
| OCR Text (Baseline) | Text in the changed region before |
| OCR Text (Actual) | Text in the changed region after |
| Changed Values | Cell-level diff: `Row 3, Col 2: "1.26" → "1.28"` |
| Confidence % | Tesseract OCR confidence (amber if < 60%) |
| Comment | Natural-language description of the change |
| Run Date | Timestamp |

---

## Updating a baseline

When a UI change is intentional, promote the latest actual to baseline:

```js
cy.task("updateBaseline", { name: "ReportName/SectionName_2025-07-31" });
```

Or simply delete the file from `cypress/snapshots/baseline/` and re-run.

---

## Folder structure after first run

```
cypress/
└── snapshots/
    ├── baseline/    ← golden images (commit to git)
    ├── actual/      ← latest run screenshots (gitignore)
    ├── diff/        ← side-by-side diff composites (gitignore)
    └── reports/
        └── diff-report.xlsx
```

---

## Privacy

- All processing is local — no images or text are sent to any server
- The English OCR language model is bundled in the package (~12MB)
- No telemetry of any kind

---

## Requirements

- Node.js >= 16
- Cypress >= 13
