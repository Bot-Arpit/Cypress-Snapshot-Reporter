"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { PNG } = require("pngjs");

const { makeSnapshotTasks, prepareImagesForCompare } = require("../src/tasks/snapshotTasks");

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "csr-test-"));
}

function writePng(filePath, { width = 4, height = 4, fill = 255, mutate } = {}) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const png = new PNG({ width, height });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = fill;
    png.data[i + 1] = fill;
    png.data[i + 2] = fill;
    png.data[i + 3] = 255;
  }
  if (typeof mutate === "function") mutate(png);
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

// 4. Minor height difference within tolerance compares the overlapping region.
test("compares overlapping region when height differs within tolerance", async () => {
  const root = makeTempRoot();
  const baselineDir = path.join(root, "baseline");
  const actualDir = path.join(root, "actual");
  const diffDir = path.join(root, "diff");
  const screenshotsDir = path.join(root, "__temp__");

  writePng(path.join(baselineDir, "Panel.png"), {
    width: 20,
    height: 12,
    mutate: (png) => {
      for (let x = 0; x < 20; x++) {
        const i = (2 * png.width + x) * 4;
        png.data[i] = 0;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
      }
    },
  });

  writePng(path.join(screenshotsDir, "Panel.png"), {
    width: 20,
    height: 11,
    mutate: (png) => {
      for (let x = 0; x < 20; x++) {
        const i = (2 * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 0;
      }
    },
  });

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir,
    screenshotTimeout: 500,
  });

  const result = await compareSnapshot({
    name: "Panel",
    screenshotPath: path.join(screenshotsDir, "Panel.png"),
  });

  assert.strictEqual(result.status, "compared");
  assert.strictEqual(result.sizeAdjusted, true);
  assert.deepStrictEqual(result.baseline, { width: 20, height: 12 });
  assert.deepStrictEqual(result.actual, { width: 20, height: 11 });
  assert.ok(result.mismatch >= 10, "overlap diff should exceed noise threshold");
  assert.ok(fs.existsSync(path.join(diffDir, "Panel.png")), "diff image should be written");
});

// 5. Size difference beyond tolerance still returns size_mismatch.
test("returns size_mismatch when dimensions exceed tolerance", async () => {
  const root = makeTempRoot();
  const baselineDir = path.join(root, "baseline");
  const actualDir = path.join(root, "actual");
  const diffDir = path.join(root, "diff");
  const screenshotsDir = path.join(root, "__temp__");

  writePng(path.join(baselineDir, "Panel.png"), { width: 20, height: 20 });
  writePng(path.join(screenshotsDir, "Panel.png"), { width: 20, height: 10 });

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir,
    screenshotTimeout: 500,
  });

  const result = await compareSnapshot({
    name: "Panel",
    screenshotPath: path.join(screenshotsDir, "Panel.png"),
  });

  assert.strictEqual(result.status, "size_mismatch");
  assert.strictEqual(result.baseline.height, 20);
  assert.strictEqual(result.actual.height, 10);
  assert.ok(!fs.existsSync(path.join(diffDir, "Panel.png")), "diff image should not be written");
});

// 6. prepareImagesForCompare crops to top-left overlap.
test("prepareImagesForCompare aligns to overlapping top-left region", () => {
  const img1 = new PNG({ width: 4, height: 3 });
  const img2 = new PNG({ width: 4, height: 2 });
  img1.data.fill(100);
  img2.data.fill(100);

  const prepared = prepareImagesForCompare(img1, img2);
  assert.ok(prepared);
  assert.strictEqual(prepared.sizeAdjusted, true);
  assert.strictEqual(prepared.img1.width, 4);
  assert.strictEqual(prepared.img1.height, 2);
  assert.strictEqual(prepared.img2.width, 4);
  assert.strictEqual(prepared.img2.height, 2);
  assert.strictEqual(prepareImagesForCompare(img1, img2, 0), null);
});

// 7. Spec-scoped keys store under nested folders and do not collide.
test("stores snapshots under nested spec/user path without collision", async () => {
  const root = makeTempRoot();
  const baselineDir = path.join(root, "baseline");
  const actualDir = path.join(root, "actual");
  const diffDir = path.join(root, "diff");
  const screenshotsDir = path.join(root, "__temp__");

  const loginShot = path.join(screenshotsDir, "login-Home.png");
  const dashShot = path.join(screenshotsDir, "dash-Home.png");
  writePng(loginShot, { fill: 200 });
  writePng(dashShot, { fill: 50 });

  const { compareSnapshot } = makeSnapshotTasks({
    baselineDir,
    actualDir,
    diffDir,
    screenshotsDir,
    screenshotTimeout: 500,
  });

  const loginKey = "login.cy/Home/Header";
  const dashKey = "dashboard.cy/Home/Header";

  const r1 = await compareSnapshot({ name: loginKey, screenshotPath: loginShot });
  const r2 = await compareSnapshot({ name: dashKey, screenshotPath: dashShot });

  assert.strictEqual(r1.status, "baseline_created");
  assert.strictEqual(r2.status, "baseline_created");
  assert.ok(fs.existsSync(path.join(baselineDir, "login.cy", "Home", "Header.png")));
  assert.ok(fs.existsSync(path.join(baselineDir, "dashboard.cy", "Home", "Header.png")));
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
