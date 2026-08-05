# cypress-snapshot-reporter

[![GitHub](https://img.shields.io/badge/GitHub-Bot--Arpit%2FCypress--Snapshot--Reporter-181717?logo=github)](https://github.com/Bot-Arpit/Cypress-Snapshot-Reporter)
[![npm](https://img.shields.io/badge/npm-cypress--snapshot--reporter-CB3837?logo=npm)](https://www.npmjs.com/package/cypress-snapshot-reporter)
[![Node](https://img.shields.io/badge/Node.js-%3E%3D%2016-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![Cypress](https://img.shields.io/badge/Cypress-%3E%3D%2013-17202C?logo=cypress&logoColor=white)](https://www.cypress.io)
[![License](https://img.shields.io/badge/License-ISC-0E8A16)](./LICENSE)

Take screenshots in Cypress, compare them to a saved baseline, and get a clear report when something looks different.

Works **fully offline** — pixel compare, OCR, and Excel.

---

## Contents

- [What it does](#what-it-does)
- [Get started](#get-started)
- [Write a test](#write-a-test)
- [Where files are saved](#where-files-are-saved)
- [Excel report](#excel-report)
- [Options](#options)
- [Results & severity](#results--severity)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## What it does

| Step | Action |
|:----:|--------|
| **1** | First run saves a **baseline** image |
| **2** | Later runs **compare** the new screenshot to that baseline |
| **3** | If they differ → side-by-side **diff** + optional **Excel** report |

Snapshots are stored **per spec file name**, so different specs never overwrite each other.

---

## Get started

### 1. Install

```bash
npm install --save-dev cypress-snapshot-reporter
```

### 2. Register the plugin

**File:** `cypress.config.js`

```js
const { defineConfig } = require("cypress");
const { configSnapshot } = require("cypress-snapshot-reporter/plugin");

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      config = configSnapshot(on, config);
      return config; // required — do not remove
    },
  },
});
```

### 3. Load the command

**File:** `cypress/support/e2e.js`

```js
import "cypress-snapshot-reporter/commands";
```

> **Important:** Always `return config` from `setupNodeEvents`.  
> Skipping this causes `Screenshot not found`.

---

## Write a test

```js
// Full page
cy.matchSnapshot("Home/Header");

// One element only
cy.get(".chart").matchSnapshot("Dashboard/Chart");

// Fail the test if the image changed
cy.matchSnapshot("Login", { failOnDiff: true });
```

Run:

```bash
npx cypress run
```

---

## Where files are saved

```text
cypress/snapshots/
├── baseline/     ← commit these (your “good” images)
├── actual/       ← latest screenshots
├── diff/         ← side-by-side when something changed
└── reports/      ← Excel report
```

**Example**

| Spec | Command | Saved as |
|------|---------|----------|
| `login.cy.js` | `cy.matchSnapshot("Home/Header")` | `baseline/login.cy/Home/Header.png` |

**`.gitignore`**

```gitignore
cypress/snapshots/actual/
cypress/snapshots/diff/
cypress/snapshots/reports/
cypress/.csr-temp/
```

---

## Excel report

By default, after `cypress run` the plugin builds an Excel file that explains text changes in the diffs (OCR).

| Mode | Badge | Behavior |
|------|-------|----------|
| `after` | default | Auto Excel after `cypress run` |
| `deferred` | manual | You run the CLI yourself |

```bash
npx cypress-snapshot-ocr-report
```

> **Note:** In `cypress open`, Excel is **not** created automatically.  
> Run the command above after your session.

**CI (deferred mode)**

```bash
npx cypress run && npx cypress-snapshot-ocr-report
```

---

## Options

### Plugin

```js
config = configSnapshot(on, config, {
  browserWidth: 1280,
  browserHeight: 800,
  snapshotOcrMode: "after", // or "deferred"
  updateBaseline: false,
});
```

| Option | Default | Meaning |
|--------|---------|---------|
| `browserWidth` | `1280` | Browser width |
| `browserHeight` | `800` | Browser height |
| `snapshotOcrMode` | `"after"` | When Excel is created |
| `updateBaseline` | `false` | Auto-replace baselines |

### Command

```js
cy.matchSnapshot("Login", {
  failOnDiff: true,
  threshold: 0.1,
  updateBaseline: false,
  runOcr: true,
});
```

| Option | Default | Meaning |
|--------|---------|---------|
| `failOnDiff` | `false` | Fail test if images differ |
| `threshold` | `0.1` | Compare sensitivity (`0`–`1`) |
| `updateBaseline` | `false` | Update this baseline |
| `runOcr` | `true` | Include in Excel report |

---

## Results & severity

### Status

| Status | Meaning |
|--------|---------|
| `baseline_created` | No baseline yet — one was saved |
| `matched` | Looks the same |
| `noise_ignored` | Tiny change (&lt; 10 px) — ignored |
| `compared` | Real difference found |
| `size_mismatch` | Different image sizes — skipped |

### Severity

| Level | When |
|-------|------|
| **Critical** | &gt; 2% of pixels changed |
| **High** | &gt; 0.5% |
| **Medium** | &gt; 0.05% |
| **Low** | smaller than that |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Screenshot not found` | `return config` in `setupNodeEvents` |
| Image looks cropped | Set `browserWidth` / `browserHeight` — don’t add your own `before:browser:launch` |
| No Excel after `cypress open` | Run `npx cypress-snapshot-ocr-report` |
| Specs overwrite each other | Files are already split by **spec name** — also use unique snapshot names |

---

## License

[ISC](./LICENSE) © Arpit Kumar

**Repo:** [Bot-Arpit/Cypress-Snapshot-Reporter](https://github.com/Bot-Arpit/Cypress-Snapshot-Reporter)
