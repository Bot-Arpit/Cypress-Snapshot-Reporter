"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("pngjs");

const { makeSnapshotTasks } = require("../src/tasks/snapshotTasks");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csr-test-"));
}

function writePng(filePath, { width = 4, height = 4 } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });
  png.data.fill(255);
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

// 1. An explicit screenshotPath is used directly, even when no configured
//    screenshots dir contains the file.
test("uses screenshotPath directly when provided", async () => {
  const root = makeTempRoot();
  const baselineDir = path.join(root, "baseline");
  const screenshotsDir = path.join(root, "__temp__");
  const externalPath = path.join(root, "elsewhere", "Home.png");
  writePng(externalPath);

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir,
    actualDir: path.join(root, "actual"),
    diffDir: path.join(root, "diff"),
    screenshotsDir,
    defaultScreenshotsDir: path.join(root, "cypress", "screenshots"),
    screenshotTimeout: 500,
  });

  const result = await compareSnapshot({ name: "Home", screenshotPath: externalPath });
  assert.strictEqual(result.status, "baseline_created");
  assert.ok(fs.existsSync(path.join(baselineDir, "Home.png")), "baseline should be created from screenshotPath");
});

// 2. Falls back to the default Cypress screenshots folder when the override
//    never applied (no screenshotPath, temp dir empty).
test("falls back to default screenshots folder", async () => {
  const root = makeTempRoot();
  const baselineDir = path.join(root, "baseline");
  const screenshotsDir = path.join(root, "__temp__"); // intentionally empty
  const defaultScreenshotsDir = path.join(root, "cypress", "screenshots");
  writePng(path.join(defaultScreenshotsDir, "Home.png"));

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir,
    actualDir: path.join(root, "actual"),
    diffDir: path.join(root, "diff"),
    screenshotsDir,
    defaultScreenshotsDir,
    screenshotTimeout: 500,
  });

  const result = await compareSnapshot({ name: "Home" });
  assert.strictEqual(result.status, "baseline_created");
  assert.ok(fs.existsSync(path.join(baselineDir, "Home.png")), "baseline should be created from default folder");
});

// 3. Error message lists the default folder and includes the return-config hint.
test("error message includes default folder and return-config hint", async () => {
  const root = makeTempRoot();
  const defaultScreenshotsDir = path.join(root, "cypress", "screenshots");
  fs.mkdirSync(defaultScreenshotsDir, { recursive: true });

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir: path.join(root, "baseline"),
    actualDir: path.join(root, "actual"),
    diffDir: path.join(root, "diff"),
    screenshotsDir: path.join(root, "__temp__"),
    defaultScreenshotsDir,
    screenshotTimeout: 200,
  });

  await assert.rejects(
    () => compareSnapshot({ name: "Missing" }),
    (err) => {
      assert.ok(/Screenshot not found/.test(err.message), "mentions not found");
      assert.ok(err.message.includes(defaultScreenshotsDir), "lists default screenshots dir");
      assert.ok(err.message.includes("return config"), "includes return config hint");
      return true;
    }
  );
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
