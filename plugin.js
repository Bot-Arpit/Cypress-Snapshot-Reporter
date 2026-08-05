"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync, spawnSync } = require("child_process");

// Best-effort: mark a directory as hidden. A leading dot already hides it on
// macOS/Linux; on Windows we also set the hidden file attribute. Failures are
// non-fatal — hiding is cosmetic.
function hideDir(dir) {
  if (process.platform !== "win32") return;
  try {
    execFileSync("attrib", ["+h", dir], { stdio: "ignore" });
  } catch (e) {}
}

function removeDir(dir) {
  try {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {}
}

// Delete the directory's contents but keep the (hidden) directory itself, so
// the hidden attribute survives between specs.
function emptyDir(dir) {
  try {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir)) {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  } catch (e) {}
}

/**
 * Resolve OCR mode.
 *   "after"    (default) — record diffs during the run; auto-run OCR in after:run
 *   "deferred"           — record diffs during the run; user runs OCR manually
 * Legacy "inline" (and any unknown value) falls back to "after" with a warning.
 */
function resolveOcrMode(raw) {
  if (raw === undefined || raw === null || raw === "after") return "after";
  if (raw === "deferred") return "deferred";
  if (raw === "inline") {
    console.warn(
      `[snapshot-reporter] snapshotOcrMode "inline" is removed; falling back to "after". ` +
        `OCR runs after the Cypress run (not during tests).`
    );
    return "after";
  }
  console.warn(
    `[snapshot-reporter] Unknown snapshotOcrMode "${raw}"; falling back to "after".`
  );
  return "after";
}

// Spawn the post-run OCR script in a child process so Tesseract stays out of
// the Cypress process. OCR failures are logged but never affect Cypress exit code.
function spawnOcrReport(pendingOcrFile, excelFile) {
  const { readManifest } = require("./src/tasks/ocrTasks");
  const manifest = readManifest(pendingOcrFile);
  if (!manifest || !Array.isArray(manifest.items) || manifest.items.length === 0) {
    return;
  }

  const scriptPath = path.join(__dirname, "scripts", "snapshot-ocr-report.js");
  const excelPath = (manifest.dirs && manifest.dirs.excelFile) || excelFile;

  console.log(
    `[snapshot-reporter] Running OCR report (${manifest.items.length} pending)...`
  );

  let result;
  try {
    result = spawnSync(process.execPath, [scriptPath, pendingOcrFile], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (e) {
    console.warn(`[snapshot-reporter] OCR report failed: ${e.message}`);
    return;
  }

  if (result.error) {
    console.warn(`[snapshot-reporter] OCR report failed to start: ${result.error.message}`);
    return;
  }

  if (result.status === 0) {
    console.log(`[snapshot-reporter] OCR report complete. Excel: ${excelPath}`);
  } else {
    console.warn(
      `[snapshot-reporter] OCR report exited with code ${result.status} (Cypress exit code unaffected)`
    );
  }
}

function configSnapshot(on, config, options = {}) {
  const root = config.projectRoot || process.cwd();
  const dir = path.join(root, "cypress", "snapshots");

  const baselineDir = options.baselineDir || path.join(dir, "baseline");
  const actualDir = options.actualDir || path.join(dir, "actual");
  const diffDir = options.diffDir || path.join(dir, "diff");
  const reportsDir = path.join(dir, "reports");
  const excelFile = options.excelFile || path.join(reportsDir, "diff-report.xlsx");
  const pendingOcrFile = options.pendingOcrFile || path.join(reportsDir, "pending-ocr.json");

  const ocrMode = resolveOcrMode(options.snapshotOcrMode);
  // Interactive (`cypress open`) never fires `after:run`, so auto-OCR cannot run.
  const isInteractive = config.isInteractive === true;

  [baselineDir, actualDir, diffDir, reportsDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  // Keep Cypress viewport and browser window in sync so screenshots are not
  // cropped to a smaller window than the configured viewport.
  const width = options.viewportWidth ?? options.browserWidth ?? 1280;
  const height = options.viewportHeight ?? options.browserHeight ?? 800;
  const maxViewportWidth = options.maxViewportWidth ?? 8192;
  const maxViewportHeight = options.maxViewportHeight ?? 8192;
  const fitToPage = options.fitToPage ?? true;
  config.viewportWidth = width;
  config.viewportHeight = height;

  // Browser window must be >= the viewport used for captures, or Chrome/Electron
  // clips screenshots. Cap launch size so Electron can still open reliably.
  const LAUNCH_WIDTH_CAP = 3840;
  const LAUNCH_HEIGHT_CAP = 2160;
  const launchWidth = fitToPage
    ? Math.max(width, Math.min(maxViewportWidth, LAUNCH_WIDTH_CAP))
    : width;
  const launchHeight = fitToPage
    ? Math.max(height, Math.min(maxViewportHeight, LAUNCH_HEIGHT_CAP))
    : height;

  config.env = config.env || {};
  config.env.snapshotBaselineDir = baselineDir;
  config.env.snapshotActualDir = actualDir;
  config.env.snapshotDiffDir = diffDir;
  config.env.snapshotExcelFile = excelFile;
  config.env.snapshotPendingOcrFile = pendingOcrFile;
  config.env.snapshotOcrMode = ocrMode;
  config.env.snapshotUpdateBaseline = options.updateBaseline ?? false;
  config.env.snapshotScreenshotTimeout = options.screenshotTimeout ?? 5000;
  config.env.snapshotViewportWidth = width;
  config.env.snapshotViewportHeight = height;
  config.env.snapshotCapture = options.capture ?? "fullPage";
  config.env.snapshotFitToPage = fitToPage;
  config.env.snapshotMaxViewportWidth = maxViewportWidth;
  config.env.snapshotMaxViewportHeight = maxViewportHeight;
  config.env.snapshotLaunchWidth = launchWidth;
  config.env.snapshotLaunchHeight = launchHeight;

  // Remember where Cypress would write screenshots BEFORE we override it. If the
  // user does not `return config` from setupNodeEvents, our override below is
  // ignored and screenshots land here instead — so the tasks use this as a
  // fallback search location.
  const defaultScreenshotsDir = config.screenshotsFolder || path.join(root, "cypress", "screenshots");

  // Internal scratch dir for raw captures. Dot-prefixed so it's hidden on
  // macOS/Linux and visually de-emphasized in editors. Clear any leftovers from
  // a previously interrupted run, then (re)create and hide it.
  const tempDir = path.join(root, "cypress", ".csr-temp");
  removeDir(tempDir);
  fs.mkdirSync(tempDir, { recursive: true });
  hideDir(tempDir);
  config.screenshotsFolder = tempDir;

  const { makeSnapshotTasks } = require("./src/tasks/snapshotTasks");
  const { makeOcrTasks } = require("./src/tasks/ocrTasks");

  const snapshotTasks = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir: tempDir,
    defaultScreenshotsDir,
    screenshotTimeout: options.screenshotTimeout ?? 5000,
  });

  const ocrTasks = makeOcrTasks({
    baselineDir,
    actualDir,
    diffDir,
    excelFile,
    pendingFile: pendingOcrFile,
  });

  // Both modes record diffs during the run; start with a clean manifest.
  ocrTasks.initPendingManifest();

  on("task", {
    compareSnapshot: snapshotTasks.compareSnapshot,
    updateBaseline: snapshotTasks.updateBaseline,
    // Kept for advanced/manual cy.task use; matchSnapshot never calls this
    // (OCR always runs outside the Cypress test process).
    ocrDiffRegions: ocrTasks.ocrDiffRegions,
    recordPendingOcr: ocrTasks.recordPendingOcr,
  });

  // After each spec, clear captures but keep the hidden dir so its attribute
  // (and tidy state) persists for the next spec.
  on("after:spec", () => {
    emptyDir(tempDir);
  });

  // After the whole run, remove the scratch dir entirely. Note: `after:run`
  // fires in `cypress run` but not in interactive `cypress open`.
  on("after:run", () => {
    removeDir(tempDir);

    if (ocrMode === "after") {
      spawnOcrReport(pendingOcrFile, excelFile);
    }
  });

  // NOTE: Cypress only keeps ONE `before:browser:launch` handler. Registering a
  // second one in your own setupNodeEvents silently overrides this one (and
  // therefore the window/viewport sizing). Configure size via
  // browserWidth/browserHeight (or viewportWidth/viewportHeight) instead.
  on("before:browser:launch", (browser, launchOptions) => {
    if (browser.name === "electron") {
      launchOptions.preferences = launchOptions.preferences || {};
      launchOptions.preferences.width = launchWidth;
      launchOptions.preferences.height = launchHeight;
    }

    // Chromium family (Chrome, Edge, Electron headless args) — window must be
    // at least as large as the viewport or screenshots get cropped.
    if (browser.family === "chromium" && Array.isArray(launchOptions.args)) {
      launchOptions.args = launchOptions.args.filter(
        (arg) => typeof arg !== "string" || !arg.startsWith("--window-size=")
      );
      launchOptions.args.push(`--window-size=${launchWidth},${launchHeight}`);
    }

    return launchOptions;
  });

  console.log(`[snapshot-reporter] Baseline: ${baselineDir}`);
  console.log(
    `[snapshot-reporter] Viewport: ${width}×${height}` +
      (fitToPage ? ` (fit-to-page on, browser window ${launchWidth}×${launchHeight})` : "")
  );
  if (ocrMode === "after") {
    console.log(
      `[snapshot-reporter] OCR mode: after (default) — pixel compare during the run; ` +
        `Excel report auto-generated after cypress run when diffs are pending`
    );
    if (isInteractive) {
      console.log(
        `[snapshot-reporter] Interactive mode (cypress open): after:run does not fire, ` +
          `so OCR will not auto-run. After your session, run: npx cypress-snapshot-ocr-report`
      );
    }
  } else {
    console.log(
      `[snapshot-reporter] OCR mode: deferred — pixel compare during the run; ` +
        `OCR is NOT auto-run. After cypress run, execute: npx cypress-snapshot-ocr-report`
    );
  }

  return config;
}

module.exports = { configSnapshot, resolveOcrMode };
