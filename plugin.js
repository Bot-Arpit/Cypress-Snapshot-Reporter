"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

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

function configSnapshot(on, config, options = {}) {
  const root = config.projectRoot || process.cwd();
  const dir = path.join(root, "cypress", "snapshots");

  const baselineDir = options.baselineDir || path.join(dir, "baseline");
  const actualDir = options.actualDir || path.join(dir, "actual");
  const diffDir = options.diffDir || path.join(dir, "diff");
  const reportsDir = path.join(dir, "reports");
  const excelFile = options.excelFile || path.join(reportsDir, "diff-report.xlsx");
  const pendingOcrFile = options.pendingOcrFile || path.join(reportsDir, "pending-ocr.json");

  // OCR execution mode:
  //   "deferred" (default) — Cypress only does the pixel compare and records
  //     diffs to pending-ocr.json; OCR runs afterwards via
  //     `node scripts/snapshot-ocr-report.js`. This keeps the Tesseract WASM
  //     core (which can crash on Node 24) out of the Cypress process.
  //   "inline" — legacy behaviour: OCR runs during the Cypress run.
  const ocrMode = options.snapshotOcrMode === "inline" ? "inline" : "deferred";

  [baselineDir, actualDir, diffDir, reportsDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  config.env = config.env || {};
  config.env.snapshotBaselineDir = baselineDir;
  config.env.snapshotActualDir = actualDir;
  config.env.snapshotDiffDir = diffDir;
  config.env.snapshotExcelFile = excelFile;
  config.env.snapshotPendingOcrFile = pendingOcrFile;
  config.env.snapshotOcrMode = ocrMode;
  config.env.snapshotUpdateBaseline = options.updateBaseline ?? false;
  config.env.snapshotScreenshotTimeout = options.screenshotTimeout ?? 5000;

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

  // Start each run with a clean manifest so the post-run report only reflects
  // this run's diffs.
  if (ocrMode === "deferred") {
    ocrTasks.initPendingManifest();
  }

  on("task", {
    compareSnapshot: snapshotTasks.compareSnapshot,
    updateBaseline: snapshotTasks.updateBaseline,
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
  });

  const width = options.browserWidth || 1280;
  const height = options.browserHeight || 800;

  // NOTE: Cypress only keeps ONE `before:browser:launch` handler. Registering a
  // second one in your own setupNodeEvents silently overrides this one (and
  // therefore the browserWidth/browserHeight sizing). Configure window size via
  // the `browserWidth`/`browserHeight` options instead of adding your own.
  on("before:browser:launch", (browser, launchOptions) => {
    if (browser.name === "electron") {
      launchOptions.preferences.width = width;
      launchOptions.preferences.height = height;
    }
    return launchOptions;
  });

  console.log(`[snapshot-reporter] Baseline: ${baselineDir}`);
  console.log(`[snapshot-reporter] OCR mode: ${ocrMode}` +
    (ocrMode === "deferred"
      ? " (run `node scripts/snapshot-ocr-report.js` after the run to build the OCR report)"
      : ""));

  return config;
}

module.exports = { configSnapshot };
