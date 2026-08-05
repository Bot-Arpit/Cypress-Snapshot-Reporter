# cypress-snapshot-reporter

<p align="center">
  <a href="https://github.com/Bot-Arpit/Cypress-Snapshot-Reporter">
    <img src="https://img.shields.io/badge/GitHub-Bot--Arpit%2FCypress--Snapshot--Reporter-181717?style=for-the-badge&logo=github" alt="GitHub" />
  </a>
  <img src="https://img.shields.io/badge/Cypress-%3E%3D%2013-17202C?style=for-the-badge&logo=cypress&logoColor=white" alt="Cypress" />
  <img src="https://img.shields.io/badge/Node-%3E%3D%2016-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node" />
  <img src="https://img.shields.io/badge/license-ISC-0E8A16?style=for-the-badge" alt="License" />
  <img src="https://img.shields.io/badge/OCR-offline-6F42C1?style=for-the-badge" alt="Offline OCR" />
</p>

<p align="center">
  <b>Visual regression for Cypress</b> — pixel diffs · severity · offline OCR · Excel reports
</p>

<p align="center">
  <a href="https://github.com/Bot-Arpit/Cypress-Snapshot-Reporter">github.com/Bot-Arpit/Cypress-Snapshot-Reporter</a>
</p>

---

## Quick start

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
      return config; // required
    },
  },
});
```

### 3. Import commands

**File:** `cypress/support/e2e.js`

```js
import "cypress-snapshot-reporter/commands";
```

### 4. Use in tests

```js
cy.matchSnapshot("Home/Header");
cy.get(".chart").matchSnapshot("Dashboard/Chart");
cy.matchSnapshot("Login", { failOnDiff: true });
```

### 5. Run

```bash
npx cypress run
```

> [!IMPORTANT]
> Always `return config` from `setupNodeEvents`. Skipping this causes `Screenshot not found`.

---

## Output layout

| Folder | Purpose | Git |
|--------|---------|-----|
| `baseline/` | Reference images | Commit |
| `actual/` | Latest captures | Ignore |
| `diff/` | Side-by-side diffs | Ignore |
| `reports/` | Excel + OCR manifest | Ignore |

```text
cypress/snapshots/
├── baseline/<spec>/<name>.png
├── actual/<spec>/<name>.png
├── diff/<spec>/<name>.png
└── reports/diff-report.xlsx
```

Example — `cy.matchSnapshot("Home/Header")` in `login.cy.js`:

```text
baseline/login.cy/Home/Header.png
```

Add to `.gitignore`:

```gitignore
cypress/snapshots/actual/
cypress/snapshots/diff/
cypress/snapshots/reports/
cypress/.csr-temp/
```

---

## Capture behavior

| Step | What happens |
|------|----------------|
| 1 | Measure page width |
| 2 | Expand viewport to full width (no horizontal crop) |
| 3 | Take a full-page screenshot (scrolls vertically) |

Wide and tall pages are both covered automatically.

---

## Excel & OCR

| Mode | When Excel is created |
|------|------------------------|
| `after` (default) | Automatically after `cypress run` |
| `deferred` | Run the CLI yourself |

```bash
npx cypress-snapshot-ocr-report
```

> [!NOTE]
> In `cypress open`, Excel is never auto-generated — use the CLI above.

OCR failures are logged but **never fail** your Cypress run.

### CI (deferred mode)

```bash
npx cypress run && npx cypress-snapshot-ocr-report
```

---

## Options

### Plugin — `configSnapshot(on, config, opts)`

| Option | Default | Description |
|--------|---------|-------------|
| `browserWidth` | `1280` | Browser / viewport width |
| `browserHeight` | `800` | Browser / viewport height |
| `snapshotOcrMode` | `"after"` | `"after"` or `"deferred"` |
| `updateBaseline` | `false` | Auto-update all baselines |

Example:

```js
config = configSnapshot(on, config, {
  browserWidth: 1280,
  browserHeight: 800,
  snapshotOcrMode: "after",
});
```

### Command — `cy.matchSnapshot(name, opts?)`

| Option | Default | Description |
|--------|---------|-------------|
| `failOnDiff` | `false` | Fail the test on a real mismatch |
| `threshold` | `0.1` | Pixelmatch sensitivity (`0`–`1`) |
| `updateBaseline` | `false` | Update baseline for this snapshot |
| `runOcr` | `true` | Include this diff in the Excel report |

Example:

```js
cy.matchSnapshot("Login", {
  failOnDiff: true,
  threshold: 0.1,
  updateBaseline: false,
});
```

---

## Compare results

| Status | Meaning |
|--------|---------|
| `baseline_created` | New baseline saved |
| `matched` | No visual difference |
| `noise_ignored` | Tiny diff (&lt; 10 px) ignored |
| `compared` | Real diff — severity assigned |
| `size_mismatch` | Image sizes differ too much |

### Severity scale

| Level | Badge | Mismatch |
|-------|-------|----------|
| Critical | ![Critical](https://img.shields.io/badge/Critical-%3E%202%25-b60205) | &gt; 2% of pixels |
| High | ![High](https://img.shields.io/badge/High-%3E%200.5%25-d93f0b) | &gt; 0.5% |
| Medium | ![Medium](https://img.shields.io/badge/Medium-%3E%200.05%25-fbca04) | &gt; 0.05% |
| Low | ![Low](https://img.shields.io/badge/Low-else-0e8a16) | Everything else |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `Screenshot not found` | `return config` from `setupNodeEvents` |
| Cropped / wrong size | Set `browserWidth` / `browserHeight` — do not add another `before:browser:launch` |
| No Excel in CI (`deferred`) | Run the CI command in the Excel section above |
| Specs overwriting images | Paths are scoped per spec name automatically |

---

## License

[ISC](./LICENSE) © Arpit Kumar

**Repo:** [Bot-Arpit/Cypress-Snapshot-Reporter](https://github.com/Bot-Arpit/Cypress-Snapshot-Reporter)
