# cypress-snapshot-reporter

Visual regression for Cypress: pixelmatch diffs, severity, OCR text compare, Excel report. Works offline.

**Requires:** Node ≥ 16 · Cypress ≥ 13 · `npm i -D cypress-snapshot-reporter`

---

## Setup

**`cypress.config.js`**

```js
const { defineConfig } = require("cypress");
const { configSnapshot } = require("cypress-snapshot-reporter/plugin");

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      config = configSnapshot(on, config, {
        snapshotOcrMode: "after", // default
        browserWidth: 1280,
        browserHeight: 800,
      });
      return config; // REQUIRED
    },
  },
});
```

**`cypress/support/e2e.js`**

```js
import "cypress-snapshot-reporter/commands";
```

**Test**

```js
cy.matchSnapshot("Home/Header");
cy.get(".chart").matchSnapshot("Dashboard/Chart"); // element only
```

**Run:** `npx cypress run`  
First call creates the baseline. Later calls compare; diffs write a side-by-side PNG and (default OCR mode) `diff-report.xlsx` after the run.

---

## Output

```text
cypress/snapshots/
  baseline/   # commit these
  actual/     # latest captures
  diff/       # side-by-side (baseline | diff | actual) when mismatch ≥ 10px
  reports/    # pending-ocr.json, diff-report.xlsx
```

Ignore `actual/`, `diff/`, `reports/`, `.csr-temp/`.

---

## OCR modes

OCR never runs inside the Cypress test process.

| Mode | Behavior |
|------|----------|
| `"after"` **(default)** | Record diffs → auto Excel via `after:run` after `cypress run` |
| `"deferred"` | Record only → run `npx cypress-snapshot-ocr-report` yourself |

`after:run` does **not** fire in `cypress open` — use the CLI for Excel. OCR failures never fail Cypress. Legacy `"inline"` → `"after"` (warned).

---

## Options

**`configSnapshot(on, config, opts)`**

| Option | Default | |
|--------|---------|---|
| `baselineDir` / `actualDir` / `diffDir` | `cypress/snapshots/{baseline,actual,diff}` | |
| `excelFile` | `…/reports/diff-report.xlsx` | |
| `pendingOcrFile` | `…/reports/pending-ocr.json` | |
| `snapshotOcrMode` | `"after"` | `"after"` \| `"deferred"` |
| `updateBaseline` | `false` | auto-promote actual → baseline |
| `browserWidth` / `browserHeight` | `1280` / `800` | Electron window |
| `screenshotTimeout` | `5000` | ms wait for PNG |

**`cy.matchSnapshot(name, opts)`**

| Option | Default | |
|--------|---------|---|
| `threshold` | `0.1` | pixelmatch sensitivity |
| `failOnDiff` | `false` | throw on real mismatch |
| `runOcr` | `true` | queue for Excel/OCR |
| `ocrMode` | plugin | `"after"` \| `"deferred"` |
| `updateBaseline` | `false` | |
| `capture` | `"fullPage"` | `"fullPage"` \| `"viewport"` \| `"runner"` |
| `screenshotTimeout` | `5000` | |

Env overrides: `snapshotThreshold`, `failOnSnapshotDiff`, `snapshotUpdateBaseline`, `snapshotScreenshotTimeout`.

**Baselines:** missing file → create. Or `cy.task("updateBaseline", { name })` / `updateBaseline: true`.

---

## Compare results

| Status | Meaning |
|--------|---------|
| `baseline_created` | Saved as new baseline |
| `matched` | 0 px diff |
| `noise_ignored` | &lt; 10 px — no diff file |
| `compared` | Real diff + severity |
| `size_mismatch` | Size differs &gt; 5px — no pixel compare |

**Severity** (% of image mismatched): Critical &gt;2% · High &gt;0.5% · Medium &gt;0.05% · else Low.

---

## Pitfalls

1. **`return config`** — otherwise screenshots miss the temp folder → `Screenshot not found`.
2. **No second `before:browser:launch`** — Cypress keeps one; yours overrides window size. Use `browserWidth` / `browserHeight`.
3. **CI:** `"after"` needs only `cypress run`. `"deferred"` → `cypress run && npx cypress-snapshot-ocr-report`.

---

## License

[ISC](./LICENSE)
