"use strict";

function addContext(title, value) {
  if (typeof cy.addTestContext === "function") {
    cy.addTestContext({ title, value });
  }
}

const {
  sanitizeSnapshotName,
  normalizeSpecRoot,
  buildSnapshotKey: buildKey,
} = require("./src/snapshotPath");
const { computeFitViewportSize } = require("./src/fitViewport");

function getSpecSnapshotRoot() {
  const relative =
    (Cypress.spec && (Cypress.spec.relative || Cypress.spec.name)) || "unknown";
  return normalizeSpecRoot(relative);
}

function buildSnapshotKey(name) {
  return buildKey(getSpecSnapshotRoot(), name);
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
  return "after";
}

function resolveBaseViewport(options = {}) {
  const width =
    options.viewportWidth ??
    Cypress.env("snapshotViewportWidth") ??
    Cypress.config("viewportWidth") ??
    1280;
  const height =
    options.viewportHeight ??
    Cypress.env("snapshotViewportHeight") ??
    Cypress.config("viewportHeight") ??
    800;
  return { width: Number(width), height: Number(height) };
}

/**
 * Expand viewport to the page's full width (removes horizontal scrollbar /
 * clipping), then keep a usable height so fullPage can scroll vertically.
 *
 * Important: never mix sync returns with cy.* commands inside the same .then().
 */
function applyFitViewport(options = {}) {
  const base = resolveBaseViewport(options);
  const fitToPage =
    options.fitToPage ??
    (Cypress.env("snapshotFitToPage") !== false && Cypress.env("snapshotFitToPage") !== "false");
  const maxWidth = Number(
    options.maxViewportWidth ?? Cypress.env("snapshotMaxViewportWidth") ?? 8192
  );
  const maxHeight = Number(
    options.maxViewportHeight ?? Cypress.env("snapshotMaxViewportHeight") ?? 8192
  );
  // Never request a viewport larger than the launched browser window.
  const launchWidth = Number(Cypress.env("snapshotLaunchWidth")) || maxWidth;
  const launchHeight = Number(Cypress.env("snapshotLaunchHeight")) || maxHeight;
  const effectiveMaxWidth = Math.min(maxWidth, launchWidth);
  const effectiveMaxHeight = Math.min(maxHeight, launchHeight);

  function verifyApplied({ width, height, fitted }) {
    return cy.document({ log: false }).then((doc) => {
      const appliedW = doc.documentElement.clientWidth;
      const appliedH = doc.documentElement.clientHeight;
      Cypress.log({
        name: "snapshot-viewport",
        message: `${width}×${height}${fitted ? " (fit)" : ""} → actual ${appliedW}×${appliedH}`,
        consoleProps: () => ({
          requested: { width, height, fitted },
          actual: { width: appliedW, height: appliedH },
          launchWindow: { width: launchWidth, height: launchHeight },
          configViewport: {
            width: Cypress.config("viewportWidth"),
            height: Cypress.config("viewportHeight"),
          },
        }),
      });

      if (Math.abs(appliedW - width) > 2) {
        Cypress.log({
          name: "snapshot-viewport-warn",
          message:
            `Viewport width not fully applied (wanted ${width}, got ${appliedW}). ` +
            `Browser window may be too small.`,
        });
      }
    });
  }

  if (!fitToPage) {
    return cy
      .viewport(base.width, base.height)
      .then(() => verifyApplied({ width: base.width, height: base.height, fitted: false }));
  }

  return cy
    .document({ log: false })
    .then((doc) => {
      const el = doc.documentElement;
      const body = doc.body || el;
      const pageWidth = Math.max(
        el.scrollWidth || 0,
        el.clientWidth || 0,
        body.scrollWidth || 0,
        body.clientWidth || 0,
        base.width
      );
      const pageHeight = Math.max(
        el.clientHeight || 0,
        body.clientHeight || 0,
        base.height
      );

      return computeFitViewportSize({
        baseWidth: base.width,
        baseHeight: base.height,
        pageWidth,
        pageHeight,
        maxWidth: effectiveMaxWidth,
        maxHeight: effectiveMaxHeight,
        fitToPage: true,
      });
    })
    .then((size) => cy.viewport(size.width, size.height).then(() => size))
    .then((size) => verifyApplied(size));
}

function handleCompareResult(result, {
  snapshotKey,
  diffDir,
  runOcr,
  ocrMode,
  autoUpdate,
  failOnDiff,
  screenshotTimeout,
}) {
  cy.log(
    `[snapshot] ${result.name} → ${result.status}` +
      (result.severity ? ` | ${result.severity}` : "") +
      (result.mismatchPercent ? ` | ${result.mismatchPercent}` : "")
  );

  if (result.status === "baseline_created") {
    addContext("Snapshot", `Baseline created: ${snapshotKey}`);
  }

  if (result.status === "size_mismatch") {
    addContext(
      "Size Mismatch",
      `${result.baseline.width}×${result.baseline.height} vs ${result.actual.width}×${result.actual.height}`
    );
  }

  const hasDiff = result.status === "compared" && result.mismatch > 0;

  if (hasDiff) {
    addContext(
      `Severity: ${result.severity}`,
      `${result.mismatch} pixels (${result.mismatchPercent})`
    );
    addContext("Diff Image", toReportPath(diffDir, snapshotKey));
  }

  if (hasDiff && runOcr) {
    cy.task("recordPendingOcr", {
      name: snapshotKey,
      mismatch: result.mismatch,
      totalPixels: result.totalPixels,
      severity: result.severity,
      mismatchPercent: result.mismatchPercent,
    }).then((rec) => {
      if (ocrMode === "deferred") {
        cy.log(
          `[ocr] deferred (${rec.pending} pending) — run npx cypress-snapshot-ocr-report after the run`
        );
        addContext(
          "OCR",
          `Deferred [${result.severity}] — run cypress-snapshot-ocr-report manually`
        );
      } else {
        cy.log(
          `[ocr] recorded (${rec.pending} pending) — Excel report auto-runs after cypress run`
        );
        addContext("OCR", `Pending [${result.severity}] — processed after the run`);
      }
    });
  }

  if (
    autoUpdate &&
    ["matched", "noise_ignored", "compared", "size_mismatch"].includes(result.status)
  ) {
    cy.task("updateBaseline", { name: snapshotKey, screenshotTimeout }).then(() => {
      cy.log(`[snapshot] baseline updated: ${snapshotKey}`);
      addContext("Snapshot", `Updated: ${snapshotKey}`);
    });
  }

  if (hasDiff && failOnDiff) {
    throw new Error(`[${result.severity}] Mismatch "${snapshotKey}": ${result.mismatchPercent}`);
  }
}

Cypress.Commands.add("matchSnapshot", { prevSubject: "optional" }, (subject, name, options = {}) => {
  const threshold = options.threshold ?? Cypress.env("snapshotThreshold") ?? 0.1;
  const failOnDiff = options.failOnDiff ?? Cypress.env("failOnSnapshotDiff") ?? false;
  const runOcr = options.runOcr ?? true;
  const ocrMode = resolveCommandOcrMode(
    options.ocrMode ?? Cypress.env("snapshotOcrMode") ?? "after"
  );
  const autoUpdate = options.updateBaseline ?? Cypress.env("snapshotUpdateBaseline") ?? false;
  const diffDir = options.diffDir ?? Cypress.env("snapshotDiffDir") ?? "cypress/snapshots/diff";
  const screenshotTimeout =
    options.screenshotTimeout ?? Cypress.env("snapshotScreenshotTimeout") ?? 5000;

  // Always fullPage for page shots so vertical content is included. Width is
  // handled by expanding the viewport to scrollWidth first (see applyFitViewport).
  // Explicit capture: "viewport" remains an escape hatch for a fixed frame only.
  const capture =
    options.capture ??
    Cypress.env("snapshotCapture") ??
    (subject ? "viewport" : "fullPage");

  if (!name) throw new Error("matchSnapshot requires a name");

  warnIfSnapshotNameHasSpaces(name);
  const safeName = sanitizeSnapshotName(name);
  const snapshotKey = buildSnapshotKey(name);

  let capturedScreenshotPath = null;
  const screenshotOptions = {
    capture,
    overwrite: true,
    onAfterScreenshot(_$el, props) {
      if (props && props.path) capturedScreenshotPath = props.path;
    },
  };

  // 1) Grow viewport to full page width (no horizontal crop)
  // 2) Wait for layout
  // 3) Capture fullPage (vertical scroll) — or element screenshot
  // 4) Compare via task
  applyFitViewport(options);
  cy.wait(150);

  if (subject) {
    cy.wrap(subject).screenshot(safeName, screenshotOptions);
  } else {
    cy.screenshot(safeName, screenshotOptions);
  }

  // Defer task payload until after screenshot so capturedScreenshotPath is set.
  // Return the task chain (don't nest cy.task().then inside cy.then(() => ...)).
  cy.then(() =>
    cy.task(
      "compareSnapshot",
      {
        name: snapshotKey,
        screenshotPath: capturedScreenshotPath,
        threshold,
        screenshotTimeout,
      },
      { timeout: 30000 }
    )
  ).then((result) => {
    handleCompareResult(result, {
      snapshotKey,
      diffDir,
      runOcr,
      ocrMode,
      autoUpdate,
      failOnDiff,
      screenshotTimeout,
    });
  });
});
