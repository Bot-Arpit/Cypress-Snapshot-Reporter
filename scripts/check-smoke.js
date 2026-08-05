"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.join(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const { configSnapshot, resolveOcrMode } = require(path.join(root, "plugin.js"));
assert(typeof configSnapshot === "function", "plugin.js must export configSnapshot");
assert(resolveOcrMode("deferred") === "deferred", "resolveOcrMode must accept deferred");

require(path.join(root, "src/snapshotPath.js"));
require(path.join(root, "src/fitViewport.js"));
require(path.join(root, "src/tasks/snapshotTasks.js"));
require(path.join(root, "src/tasks/ocrTasks.js"));

const { buildSnapshotKey } = require(path.join(root, "src/snapshotPath.js"));
  assert(
  buildSnapshotKey("cypress/e2e/a.cy.js", "Home/Header") === "a.cy/Home/Header",
  "buildSnapshotKey should use spec file name only"
);

const { computeFitViewportSize } = require(path.join(root, "src/fitViewport.js"));
assert(
  computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 2000,
    pageHeight: 800,
  }).width === 2000,
  "fit viewport should expand to page width"
);

// Plugin wiring smoke: viewport + launch window + tasks registered
const fsTmp = require("os").tmpdir();
const projectRoot = fs.mkdtempSync(path.join(fsTmp, "csr-smoke-"));
const handlers = {};
const on = (event, fn) => {
  handlers[event] = fn;
};
const config = { projectRoot, env: {} };
const returned = configSnapshot(on, config, {
  browserWidth: 1280,
  browserHeight: 800,
  fitToPage: true,
  maxViewportWidth: 3840,
  maxViewportHeight: 2160,
});
assert(returned === config, "configSnapshot must return config");
assert(config.viewportWidth === 1280, "viewportWidth should be set");
assert(config.env.snapshotLaunchWidth === 3840, "launch width should expand for fitToPage");
assert(typeof handlers.task.compareSnapshot === "function", "compareSnapshot task missing");
assert(typeof handlers["before:browser:launch"] === "function", "browser launch handler missing");


const tessdata = path.join(root, "src/tessdata/eng.traineddata.gz");
assert(fs.existsSync(tessdata), `Missing bundled tessdata: ${tessdata}`);
assert(fs.statSync(tessdata).size > 1000, "Bundled tessdata file looks too small");

const cli = path.join(root, "scripts/snapshot-ocr-report.js");
const out = execFileSync(process.execPath, [cli], { encoding: "utf8" });
assert(/No diffs to process/.test(out), "CLI should exit cleanly when no diffs exist");

console.log("Smoke checks passed.");
