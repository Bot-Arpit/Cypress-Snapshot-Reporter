"use strict";

function addContext(title, value) {
  if (typeof cy.addTestContext === "function") {
    cy.addTestContext({ title, value });
  }
}

const WINDOWS_INVALID_CHARS = /[<>:"|?*]/g;

function sanitizeSnapshotName(name) {
  return String(name || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/$/, "")
    .replace(WINDOWS_INVALID_CHARS, "_");
}

function warnIfSnapshotNameHasSpaces(name) {
  const raw = String(name || "");
  if (raw !== raw.trim()) {
    Cypress.log({
      name: "snapshot-warning",
      message: `Snapshot name "${raw}" has leading/trailing spaces; they will be trimmed.`,
      consoleProps: () => ({ name: raw }),
    });
  }
}

function toReportPath(baseDir, snapshotName) {
  const base = String(baseDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const name = String(snapshotName || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return `${base}/${name}.png`;
}

Cypress.Commands.add("matchSnapshot", { prevSubject: "optional" }, (subject, name, options = {}) => {
  const threshold = options.threshold ?? Cypress.env("snapshotThreshold") ?? 0.1;
  const failOnDiff = options.failOnDiff ?? Cypress.env("failOnSnapshotDiff") ?? false;
  const runOcr = options.runOcr ?? true;
  // "deferred" (default): record diffs now, run OCR after the Cypress run.
  // "inline": run OCR during the test (legacy; can crash the WASM core on Node 24).
  const ocrMode = options.ocrMode ?? Cypress.env("snapshotOcrMode") ?? "deferred";
  const autoUpdate = options.updateBaseline ?? Cypress.env("snapshotUpdateBaseline") ?? false;
  const diffDir = options.diffDir ?? Cypress.env("snapshotDiffDir") ?? "cypress/snapshots/diff";
  const screenshotTimeout =
    options.screenshotTimeout ?? Cypress.env("snapshotScreenshotTimeout") ?? 5000;
  // `capture` keeps the historical full-page default. When a subject element is
  // chained, the element is captured directly (Cypress ignores `capture` for
  // element screenshots), which avoids full-page stitching failures on very
  // large viewports.
  const capture = options.capture ?? "fullPage";

  if (!name) throw new Error("matchSnapshot requires a name");

  warnIfSnapshotNameHasSpaces(name);
  const safeName = sanitizeSnapshotName(name);

  // Capture the EXACT path Cypress writes to via onAfterScreenshot, so the task
  // never has to guess which folder the screenshot landed in (it differs when
  // the screenshotsFolder override was not applied because setupNodeEvents did
  // not `return config`).
  let capturedScreenshotPath = null;
  const screenshotOptions = {
    capture,
    overwrite: true,
    onAfterScreenshot(_$el, props) {
      if (props && props.path) capturedScreenshotPath = props.path;
    },
  };

  cy.wait(100);
  if (subject) {
    cy.wrap(subject).screenshot(safeName, screenshotOptions);
  } else {
    cy.screenshot(safeName, screenshotOptions);
  }

  // Defer building the task payload until after the screenshot has run so the
  // captured path is populated (command args are evaluated at queue time).
  cy.then(() =>
    cy.task(
      "compareSnapshot",
      { name: safeName, screenshotPath: capturedScreenshotPath, threshold, screenshotTimeout },
      { timeout: 30000 }
    ).then((result) => {
    cy.log(
      `[snapshot] ${result.name} → ${result.status}` +
      (result.severity ? ` | ${result.severity}` : "") +
      (result.mismatchPercent ? ` | ${result.mismatchPercent}` : "")
    );

    if (result.status === "baseline_created") {
      addContext("Snapshot", `Baseline created: ${name}`);
    }

    if (result.status === "size_mismatch") {
      addContext("Size Mismatch", `${result.baseline.width}×${result.baseline.height} vs ${result.actual.width}×${result.actual.height}`);
    }

    const hasDiff = result.status === "compared" && result.mismatch > 0;

    if (hasDiff) {
      addContext(`Severity: ${result.severity}`, `${result.mismatch} pixels (${result.mismatchPercent})`);
      addContext("Diff Image", toReportPath(diffDir, safeName));
    }

    if (hasDiff && runOcr && ocrMode === "deferred") {
      // Defer OCR: only record the diff now. The heavy (and on Node 24
      // crash-prone) Tesseract pass runs after the Cypress run via
      // `node scripts/snapshot-ocr-report.js`.
      cy.task("recordPendingOcr", {
        name: safeName,
        mismatch: result.mismatch,
        totalPixels: result.totalPixels,
        severity: result.severity,
        mismatchPercent: result.mismatchPercent,
      }).then((rec) => {
        cy.log(`[ocr] deferred (${rec.pending} pending) — run snapshot-ocr-report after the run`);
        addContext("OCR", `Deferred [${result.severity}] — processed after the run`);
      });
    }

    if (hasDiff && runOcr && ocrMode === "inline") {
      cy.task("ocrDiffRegions", {
        name: safeName,
        mismatch: result.mismatch,
        totalPixels: result.totalPixels,
        severity: result.severity,
      }).then((ocr) => {
        cy.log(`[ocr] ${ocr.status}`);

        if (ocr.status === "success") {
          cy.log(`[ocr] ${ocr.regionsProcessed} regions → ${ocr.excelPath}`);
          ocr.results.forEach((r, i) => {
            addContext(`Region ${i + 1} [${result.severity}]`, `${r.contentType} | ${r.confidence}%`);
            addContext(`Region ${i + 1} Baseline`, r.baselineText || "(no text)");
            addContext(`Region ${i + 1} Actual`, r.actualText || "(no text)");
          });
          addContext("Excel Report", ocr.excelPath);
        } else {
          addContext("OCR", ocr.status);
        }
      });
    }

    if (autoUpdate && ["matched", "noise_ignored", "compared", "size_mismatch"].includes(result.status)) {
      cy.task("updateBaseline", { name: safeName, screenshotTimeout }).then(() => {
        cy.log(`[snapshot] baseline updated: ${name}`);
        addContext("Snapshot", `Updated: ${name}`);
      });
    }

    if (hasDiff && failOnDiff) {
      throw new Error(`[${result.severity}] Mismatch "${name}": ${result.mismatchPercent}`);
    }
    })
  );
});
