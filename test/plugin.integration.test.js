"use strict";

/**
 * Integration-style checks for the plugin without a full Cypress browser run.
 * Covers: configSnapshot wiring, viewport/env, nested snapshot compare, OCR CLI.
 */

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("pngjs");

const root = path.join(__dirname, "..");
const { configSnapshot, resolveOcrMode } = require(path.join(root, "plugin.js"));
const { makeSnapshotTasks } = require(path.join(root, "src/tasks/snapshotTasks"));
const { computeFitViewportSize } = require(path.join(root, "src/fitViewport"));
const { buildSnapshotKey } = require(path.join(root, "src/snapshotPath"));

function writePng(filePath, { width = 8, height = 8, fill = 200 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill;
    png.data[i + 1] = fill;
    png.data[i + 2] = fill;
    png.data[i + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

function makeFakeOn() {
  const handlers = {};
  const on = (event, fn) => {
    handlers[event] = fn;
  };
  return { on, handlers };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("resolveOcrMode maps legacy inline to after", () => {
  assert.strictEqual(resolveOcrMode("after"), "after");
  assert.strictEqual(resolveOcrMode("deferred"), "deferred");
  assert.strictEqual(resolveOcrMode("inline"), "after");
  assert.strictEqual(resolveOcrMode("nope"), "after");
});

test("configSnapshot sets viewport env and returns config", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csr-plugin-"));
  const { on, handlers } = makeFakeOn();
  const config = {
    projectRoot,
    env: {},
    screenshotsFolder: path.join(projectRoot, "cypress", "screenshots"),
  };

  const out = configSnapshot(on, config, {
    browserWidth: 1440,
    browserHeight: 900,
    fitToPage: true,
    maxViewportWidth: 3840,
    maxViewportHeight: 2160,
    snapshotOcrMode: "deferred",
  });

  assert.strictEqual(out, config, "must return config");
  assert.strictEqual(config.viewportWidth, 1440);
  assert.strictEqual(config.viewportHeight, 900);
  assert.strictEqual(config.env.snapshotViewportWidth, 1440);
  assert.strictEqual(config.env.snapshotViewportHeight, 900);
  assert.strictEqual(config.env.snapshotFitToPage, true);
  assert.strictEqual(config.env.snapshotOcrMode, "deferred");
  assert.strictEqual(config.env.snapshotLaunchWidth, 3840);
  assert.strictEqual(config.env.snapshotLaunchHeight, 2160);
  assert.ok(config.screenshotsFolder.includes(".csr-temp"));

  assert.strictEqual(typeof handlers.task, "object");
  assert.strictEqual(typeof handlers["before:browser:launch"], "function");
  assert.strictEqual(typeof handlers["after:run"], "function");
  assert.strictEqual(typeof handlers["after:spec"], "function");

  // Simulate Chromium launch — window must use launch size, not base viewport only.
  const launchOptions = handlers["before:browser:launch"](
    { name: "chrome", family: "chromium" },
    { args: ["--window-size=800,600"] }
  );
  assert.ok(
    launchOptions.args.some((a) => a === "--window-size=3840,2160"),
    `expected launch window 3840x2160, got: ${launchOptions.args.join(" ")}`
  );

  // Electron preferences
  const electronOpts = handlers["before:browser:launch"](
    { name: "electron", family: "chromium" },
    { preferences: {}, args: [] }
  );
  assert.strictEqual(electronOpts.preferences.width, 3840);
  assert.strictEqual(electronOpts.preferences.height, 2160);

  assert.ok(fs.existsSync(path.join(projectRoot, "cypress", "snapshots", "baseline")));
});

test("configSnapshot without fitToPage keeps browser window at base size", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csr-plugin-"));
  const { on, handlers } = makeFakeOn();
  const config = { projectRoot, env: {} };

  configSnapshot(on, config, {
    browserWidth: 1280,
    browserHeight: 800,
    fitToPage: false,
  });

  assert.strictEqual(config.env.snapshotLaunchWidth, 1280);
  assert.strictEqual(config.env.snapshotLaunchHeight, 800);

  const launchOptions = handlers["before:browser:launch"](
    { name: "chrome", family: "chromium" },
    { args: [] }
  );
  assert.ok(launchOptions.args.includes("--window-size=1280,800"));
});

test("compareSnapshot works with spec-scoped nested paths", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "csr-compare-"));
  const baselineDir = path.join(tmp, "baseline");
  const actualDir = path.join(tmp, "actual");
  const diffDir = path.join(tmp, "diff");
  const shot = path.join(tmp, "capture.png");
  writePng(shot, { fill: 180 });

  const key = buildSnapshotKey("cypress/e2e/login.cy.js", "Home/Header");
  assert.strictEqual(key, "login.cy/Home/Header");

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir: path.join(tmp, "temp"),
    screenshotTimeout: 500,
  });

  const created = await compareSnapshot({ name: key, screenshotPath: shot });
  assert.strictEqual(created.status, "baseline_created");
  assert.ok(
    fs.existsSync(path.join(baselineDir, "login.cy", "Home", "Header.png"))
  );

  // Second capture identical → matched
  const matched = await compareSnapshot({ name: key, screenshotPath: shot });
  assert.strictEqual(matched.status, "matched");
});

test("fit viewport expands to page width and caps to max", () => {
  const fitted = computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 2500,
    pageHeight: 800,
    maxWidth: 3840,
  });
  assert.strictEqual(fitted.width, 2500);
  assert.strictEqual(fitted.fitted, true);

  const capped = computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 9000,
    pageHeight: 800,
    maxWidth: 3840,
  });
  assert.strictEqual(capped.width, 3840);
});

test("plugin tasks compareSnapshot and updateBaseline are callable", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "csr-tasks-"));
  const { on, handlers } = makeFakeOn();
  const config = { projectRoot, env: {} };
  configSnapshot(on, config, { snapshotOcrMode: "deferred" });

  const shot = path.join(projectRoot, "shot.png");
  writePng(shot, { fill: 100 });

  const name = "demo.cy/Widget";
  const result = await handlers.task.compareSnapshot({
    name,
    screenshotPath: shot,
  });
  assert.strictEqual(result.status, "baseline_created");

  // Change pixel → compared (or noise). Write a different image as "actual" path via new shot.
  writePng(shot, { fill: 10 });
  const result2 = await handlers.task.compareSnapshot({
    name,
    screenshotPath: shot,
  });
  assert.ok(
    ["compared", "noise_ignored", "matched", "size_mismatch"].includes(result2.status),
    `unexpected status ${result2.status}`
  );

  if (result2.status === "compared") {
    const updated = await handlers.task.updateBaseline({ name });
    assert.strictEqual(updated.status, "baseline_updated");
  }
});

(async () => {
  let failures = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`  ok - ${name}`);
    } catch (err) {
      failures += 1;
      console.error(`  FAIL - ${name}`);
      console.error(`    ${err && err.stack ? err.stack : err}`);
    }
  }
  console.log(`\n${tests.length - failures}/${tests.length} passed`);
  if (failures) process.exit(1);
})();
