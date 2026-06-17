"use strict";

const fs = require("fs");
const path = require("path");

function configSnapshot(on, config, options = {}) {
  const root = config.projectRoot || process.cwd();
  const dir = path.join(root, "cypress", "snapshots");

  const baselineDir = options.baselineDir || path.join(dir, "baseline");
  const actualDir = options.actualDir || path.join(dir, "actual");
  const diffDir = options.diffDir || path.join(dir, "diff");
  const reportsDir = path.join(dir, "reports");
  const excelFile = options.excelFile || path.join(reportsDir, "diff-report.xlsx");

  [baselineDir, actualDir, diffDir, reportsDir].forEach(d => {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  });

  config.env = config.env || {};
  config.env.snapshotBaselineDir = baselineDir;
  config.env.snapshotActualDir = actualDir;
  config.env.snapshotDiffDir = diffDir;
  config.env.snapshotExcelFile = excelFile;
  config.env.snapshotUpdateBaseline = options.updateBaseline ?? false;

  const tempDir = path.join(root, "cypress", "__temp__");
  config.screenshotsFolder = tempDir;

  const { makeSnapshotTasks } = require("./src/tasks/snapshotTasks");
  const { makeOcrTasks } = require("./src/tasks/ocrTasks");

  const snapshotTasks = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir: tempDir,
  });

  const ocrTasks = makeOcrTasks({
    baselineDir,
    actualDir,
    diffDir,
    excelFile,
  });

  on("task", {
    compareSnapshot: snapshotTasks.compareSnapshot,
    updateBaseline: snapshotTasks.updateBaseline,
    ocrDiffRegions: ocrTasks.ocrDiffRegions,
  });

  on("after:spec", () => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const width = options.browserWidth || 1280;
  const height = options.browserHeight || 800;

  on("before:browser:launch", (browser, launchOptions) => {
    if (browser.name === "electron") {
      launchOptions.preferences.width = width;
      launchOptions.preferences.height = height;
    }
    return launchOptions;
  });

  console.log(`[snapshot-reporter] Baseline: ${baselineDir}`);

  return config;
}

module.exports = { configSnapshot };
