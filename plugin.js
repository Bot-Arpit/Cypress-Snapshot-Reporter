"use strict";

/**
 * cypress-snapshot-reporter — plugin entry
 *
 * Usage in cypress.config.js:
 *
 *   const { configSnapshot } = require("cypress-snapshot-reporter/plugin");
 *
 *   setupNodeEvents(on, config) {
 *     configSnapshot(on, config);          // all defaults
 *     // or with custom options:
 *     configSnapshot(on, config, {
 *       baselineDir:  "cypress/snapshots/baseline",
 *       actualDir:    "cypress/snapshots/actual",
 *       diffDir:      "cypress/snapshots/diff",
 *       excelFile:    "cypress/snapshots/reports/diff-report.xlsx",
 *       updateBaseline: false,
 *       browserWidth:  6400,
 *       browserHeight: 4400,
 *     });
 *     return config;
 *   }
 */
function configSnapshot(on, config, options = {}) {
  const baselineDir    = options.baselineDir || "cypress/snapshots/baseline";
  const actualDir      = options.actualDir   || "cypress/snapshots/actual";
  const diffDir        = options.diffDir     || "cypress/snapshots/diff";
  const screenshotsDir = config.screenshotsFolder || actualDir;

  if (!config.screenshotsFolder) {
    config.screenshotsFolder = screenshotsDir;
  }

  // Resolve task modules with options injected
  const { makeSnapshotTasks } = require("./src/tasks/snapshotTasks");
  const { makeOcrTasks }      = require("./src/tasks/ocrTasks");

  const snapshotTasks = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir,
  });

  const ocrTasks = makeOcrTasks({
    baselineDir,
    actualDir,
    diffDir,
    excelFile:   options.excelFile   || "cypress/snapshots/reports/diff-report.xlsx",
  });

  on("task", {
    compareSnapshot:  snapshotTasks.compareSnapshot,
    updateBaseline:   snapshotTasks.updateBaseline,
    ocrDiffRegions:   ocrTasks.ocrDiffRegions,
  });

  // Expose plugin-level defaults to browser-side commands.js via Cypress.env().
  // Command-level options can still override these per call.
  config.env = config.env || {};
  if (config.env.snapshotUpdateBaseline === undefined) {
    config.env.snapshotUpdateBaseline = options.updateBaseline ?? false;
  }
  if (config.env.snapshotDiffDir === undefined) {
    config.env.snapshotDiffDir = diffDir;
  }

  const browserWidth  = options.browserWidth  || 6400;
  const browserHeight = options.browserHeight || 4400;

  on("before:browser:launch", (browser, launchOptions) => {
    if (browser.name === "electron") {
      launchOptions.preferences.width  = browserWidth;
      launchOptions.preferences.height = browserHeight;
    }
    return launchOptions;
  });

  return config;
}

module.exports = { configSnapshot };
