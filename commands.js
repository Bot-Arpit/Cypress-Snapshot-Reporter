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

/** Normalize OCR mode; legacy "inline" and unknowns map to "after". */
function resolveCommandOcrMode(raw) {
  if (raw === "deferred") return "deferred";
  if (raw === "after" || raw === undefined || raw === null) return "after";
  // "inline" and anything else → after (OCR never runs inside the test process)
  return "after";
}

Cypress.Commands.add("matchSnapshot", { prevSubject: "optional" }, (subject, name, options = {}) => {
  const threshold = options.threshold ?? Cypress.env("snapshotThreshold") ?? 0.1;
  const failOnDiff = options.failOnDiff ?? Cypress.env("failOnSnapshotDiff") ?? false;
  const runOcr = options.runOcr ?? true;
  // Both "after" and "deferred" only record pending OCR here — never run Tesseract
  // inside the Cypress test process (avoids Node 24 WASM crashes).
  const ocrMode = resolveCommandOcrMode(
    options.ocrMode ?? Cypress.env("snapshotOcrMode") ?? "after"
  );
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

    if (hasDiff && runOcr) {
      // Record only — OCR runs after the Cypress process (mode "after") or via
      // `npx cypress-snapshot-ocr-report` (mode "deferred").
      cy.task("recordPendingOcr", {
        name: safeName,
        mismatch: result.mismatch,
        totalPixels: result.totalPixels,
        severity: result.severity,
        mismatchPercent: result.mismatchPercent,
      }).then((rec) => {
        if (ocrMode === "deferred") {
          cy.log(
            `[ocr] deferred (${rec.pending} pending) — run npx cypress-snapshot-ocr-report after the run`
          );
          addContext("OCR", `Deferred [${result.severity}] — run cypress-snapshot-ocr-report manually`);
        } else {
          cy.log(
            `[ocr] recorded (${rec.pending} pending) — Excel report auto-runs after cypress run`
          );
          addContext("OCR", `Pending [${result.severity}] — processed after the run`);
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
