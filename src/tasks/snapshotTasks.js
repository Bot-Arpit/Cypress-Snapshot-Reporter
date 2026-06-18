const fs = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");
const { COMPOSITE_SEP } = require("./constants");

const DEFAULT_BASELINE_DIR = "cypress/snapshots/baseline";
const DEFAULT_ACTUAL_DIR = "cypress/snapshots/actual";
const DEFAULT_DIFF_DIR = "cypress/snapshots/diff";

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function waitForFile(filePath, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(filePath)) return true;
    const now = Date.now();
    while (Date.now() - now < 50) {}
  }
  return false;
}

function resolveScreenshotPath(dir, safeName, waitTimeout = 5000) {
  const directPath = path.join(dir, `${safeName}.png`);
  if (waitForFile(directPath, waitTimeout)) return directPath;
  if (!fs.existsSync(dir)) return null;

  const tail = `${path.sep}${safeName}.png`.toLowerCase();
  const startTime = Date.now();

  while (Date.now() - startTime < waitTimeout) {
    let bestMatch = null;
    let bestMtime = -1;

    const walk = (currentDir) => {
      try {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(currentDir, entry.name);
          if (entry.isDirectory()) {
            walk(fullPath);
            continue;
          }
          if (!entry.isFile()) continue;
          if (!fullPath.toLowerCase().endsWith(tail)) continue;

          const { mtimeMs } = fs.statSync(fullPath);
          if (mtimeMs > bestMtime) {
            bestMtime = mtimeMs;
            bestMatch = fullPath;
          }
        }
      } catch (e) {}
    };

    walk(dir);
    if (bestMatch) return bestMatch;

    const now = Date.now();
    while (Date.now() - now < 100) {}
  }

  return null;
}

function placeScreenshot({ safeName, name, destDir, SCREENSHOTS_DIR }) {
  const destPath = path.join(destDir, `${safeName}.png`);
  const screenshotPath = resolveScreenshotPath(SCREENSHOTS_DIR, safeName) || resolveScreenshotPath(destDir, safeName);

  if (!screenshotPath) {
    throw new Error(`Screenshot not found: "${name}"`);
  }

  ensureDir(destPath);
  if (!samePath(screenshotPath, destPath)) {
    fs.copyFileSync(screenshotPath, destPath);
  }

  return destPath;
}

function copyPanel(src, dst, offsetX) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width + x) * 4;
      const di = (y * dst.width + (x + offsetX)) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

function drawSeparator(dst, offsetX, sepWidth, r = 45, g = 45, b = 45) {
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < sepWidth; x++) {
      const di = (y * dst.width + (offsetX + x)) * 4;
      dst.data[di] = r;
      dst.data[di + 1] = g;
      dst.data[di + 2] = b;
      dst.data[di + 3] = 255;
    }
  }
}

function createSideBySide(baseline, actual, diff) {
  const SEP = COMPOSITE_SEP;
  const W = baseline.width;
  const H = baseline.height;
  const totalW = W * 3 + SEP * 2;

  const composite = new PNG({ width: totalW, height: H });

  composite.data.fill(0);
  for (let i = 3; i < composite.data.length; i += 4) composite.data[i] = 255;

  copyPanel(baseline, composite, 0);
  drawSeparator(composite, W, SEP);
  copyPanel(diff, composite, W + SEP);
  drawSeparator(composite, W * 2 + SEP, SEP);
  copyPanel(actual, composite, W * 2 + SEP * 2);

  return PNG.sync.write(composite);
}

const PIXELMATCH_OPTIONS = {
  threshold: 0.1,
  includeAA: false,
  alpha: 0.35,
  diffColor: [220, 38, 38],
  diffColorAlt: [234, 179, 8],
};

const MIN_MISMATCH_PIXELS = 10;

const SEVERITY_THRESHOLDS = {
  critical: 2.0,
  high: 0.5,
  medium: 0.05,
};

function getSeverity(mismatch, totalPixels) {
  const pct = (mismatch / totalPixels) * 100;
  if (pct > SEVERITY_THRESHOLDS.critical) return { level: "Critical", pct, argb: "FFFF4444" };
  if (pct > SEVERITY_THRESHOLDS.high) return { level: "High", pct, argb: "FFFF8800" };
  if (pct > SEVERITY_THRESHOLDS.medium) return { level: "Medium", pct, argb: "FFFFFF00" };
  return { level: "Low", pct, argb: "FF90EE90" };
}

function compareSnapshot({
  name,
  threshold = PIXELMATCH_OPTIONS.threshold,
  BASELINE_DIR = DEFAULT_BASELINE_DIR,
  ACTUAL_DIR = DEFAULT_ACTUAL_DIR,
  DIFF_DIR = DEFAULT_DIFF_DIR,
  SCREENSHOTS_DIR = ACTUAL_DIR,
}) {
  const safeName = name.replace(/\//g, path.sep);
  const baselinePath = path.join(BASELINE_DIR, `${safeName}.png`);
  const diffPath = path.join(DIFF_DIR, `${safeName}.png`);

  // No baseline at this path → this capture becomes the baseline. Nothing goes to actual/.
  if (!fs.existsSync(baselinePath)) {
    placeScreenshot({ safeName, name, destDir: BASELINE_DIR, SCREENSHOTS_DIR });
    removeIfExists(diffPath);
    return { status: "baseline_created", name };
  }

  // Baseline exists → store this capture in actual/ and compare.
  const actualPath = placeScreenshot({ safeName, name, destDir: ACTUAL_DIR, SCREENSHOTS_DIR });

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(actualPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    removeIfExists(diffPath);
    return {
      status: "size_mismatch",
      name,
      baseline: { width: img1.width, height: img1.height },
      actual: { width: img2.width, height: img2.height },
    };
  }

  const diff = new PNG({ width: img1.width, height: img1.height });
  const totalPixels = img1.width * img1.height;
  const mismatch = pixelmatch(img1.data, img2.data, diff.data, img1.width, img1.height, {
    ...PIXELMATCH_OPTIONS,
    threshold,
  });

  if (mismatch === 0) {
    removeIfExists(diffPath);
    return { status: "matched", name, mismatch: 0, mismatchPercent: "0.0000%" };
  }

  if (mismatch < MIN_MISMATCH_PIXELS) {
    removeIfExists(diffPath);
    return { status: "noise_ignored", name, mismatch, mismatchPercent: "< noise" };
  }

  const severity = getSeverity(mismatch, totalPixels);

  ensureDir(diffPath);
  fs.writeFileSync(diffPath, createSideBySide(img1, img2, diff));

  return {
    status: "compared",
    name,
    mismatch,
    totalPixels,
    mismatchPercent: `${severity.pct.toFixed(4)}%`,
    severity: severity.level,
    severityArgb: severity.argb,
  };
}

function updateBaseline({ name, BASELINE_DIR = DEFAULT_BASELINE_DIR, ACTUAL_DIR = DEFAULT_ACTUAL_DIR }) {
  const safeName = name.replace(/\//g, path.sep);
  const actualPath = resolveScreenshotPath(ACTUAL_DIR, safeName);
  const baselinePath = path.join(BASELINE_DIR, `${safeName}.png`);

  if (!actualPath) {
    throw new Error(`Screenshot not found: ${safeName}`);
  }
  ensureDir(baselinePath);
  fs.copyFileSync(actualPath, baselinePath);
  return { status: "baseline_updated", name };
}

function makeSnapshotTasks(options = {}) {
  const BASELINE_DIR = options.baselineDir || DEFAULT_BASELINE_DIR;
  const ACTUAL_DIR = options.actualDir || DEFAULT_ACTUAL_DIR;
  const DIFF_DIR = options.diffDir || DEFAULT_DIFF_DIR;
  const SCREENSHOTS_DIR = options.screenshotsDir || ACTUAL_DIR;
  return {
    compareSnapshot: (params) =>
      compareSnapshot({ ...params, BASELINE_DIR, ACTUAL_DIR, DIFF_DIR, SCREENSHOTS_DIR }),
    updateBaseline: (params) => updateBaseline({ ...params, BASELINE_DIR, ACTUAL_DIR }),
  };
}

module.exports = { makeSnapshotTasks, compareSnapshot, updateBaseline };
