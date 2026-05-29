const fs   = require("fs");
const path = require("path");
const { PNG } = require("pngjs");
const pixelmatch = require("pixelmatch");
const { COMPOSITE_SEP } = require("./constants");

const DEFAULT_BASELINE_DIR = "cypress/snapshots/baseline";
const DEFAULT_ACTUAL_DIR   = "cypress/snapshots/actual";
const DEFAULT_DIFF_DIR     = "cypress/snapshots/diff";

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

/**
 * Copies one PNG object's pixels into a destination PNG at a given x offset.
 */
function copyPanel(src, dst, offsetX) {
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (y * src.width  + x) * 4;
      const di = (y * dst.width  + (x + offsetX)) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/**
 * Draws a solid-colour vertical separator stripe into a PNG at a given x offset.
 * Default colour: dark charcoal  #2D2D2D
 */
function drawSeparator(dst, offsetX, sepWidth, r = 45, g = 45, b = 45) {
  for (let y = 0; y < dst.height; y++) {
    for (let x = 0; x < sepWidth; x++) {
      const di = (y * dst.width + (offsetX + x)) * 4;
      dst.data[di]     = r;
      dst.data[di + 1] = g;
      dst.data[di + 2] = b;
      dst.data[di + 3] = 255;
    }
  }
}

/**
 * Builds a side-by-side comparison image:
 *   [ BASELINE ] | [ DIFF ] | [ ACTUAL ]
 *
 * @param {PNG} baseline  - parsed PNG object (left panel)
 * @param {PNG} actual    - parsed PNG object (right panel)
 * @param {PNG} diff      - parsed PNG object with red highlights (middle panel)
 * @returns {Buffer}      - PNG buffer of the composite image
 */
function createSideBySide(baseline, actual, diff) {
  const SEP    = COMPOSITE_SEP;
  const W      = baseline.width;
  const H      = baseline.height;
  const totalW = W * 3 + SEP * 2;

  const composite = new PNG({ width: totalW, height: H });

  // Default fill: opaque black background (covers any unset pixels)
  composite.data.fill(0);
  for (let i = 3; i < composite.data.length; i += 4) composite.data[i] = 255;

  // Left panel  → baseline
  copyPanel(baseline, composite, 0);

  // Separator 1
  drawSeparator(composite, W, SEP);

  // Middle panel → diff (red highlights on the baseline content)
  copyPanel(diff, composite, W + SEP);

  // Separator 2
  drawSeparator(composite, W * 2 + SEP, SEP);

  // Right panel  → actual
  copyPanel(actual, composite, W * 2 + SEP * 2);

  return PNG.sync.write(composite);
}

/**
 * Pixelmatch options tuned for browser-rendered financial report screenshots.
 *
 * threshold   0.1  — high sensitivity: detects small numeric changes like
 *                    "1.26 → 1.28" which only affect ~15-30 pixels.
 *                    Anti-aliasing noise is handled separately via includeAA.
 * includeAA   false — anti-aliased edge pixels (curved fonts, borders) are
 *                    detected and SKIPPED, not flagged. This is the primary
 *                    noise filter — more targeted than raising threshold.
 * alpha       0.35  — original image shows through at 35% in the diff panel
 *                    so you can see exactly which cell/number changed.
 * diffColor         — bright red for changed pixels
 * diffColorAlt      — yellow safety (unused while includeAA: false)
 */
const PIXELMATCH_OPTIONS = {
  threshold:    0.1,
  includeAA:    false,
  alpha:        0.35,
  diffColor:    [220, 38,  38],
  diffColorAlt: [234, 179, 8],
};

/**
 * Minimum differing pixels to be considered a real diff.
 * Set very low (10) — just enough to ignore 1-2 stray random pixels
 * from browser compositing, while still catching a single changed digit
 * (which produces ~15-30 diff pixels at report font sizes).
 */
const MIN_MISMATCH_PIXELS = 10;

/**
 * Severity thresholds — based on % of total image pixels that differ.
 *
 * CRITICAL  > 2.0%  — large section of the report changed (whole table, page layout)
 * HIGH      > 0.5%  — a significant block changed (multi-row table, chart)
 * MEDIUM    > 0.05% — a few rows or cells changed
 * LOW       > 0%    — a single value / digit changed (e.g. 1.26 → 1.28)
 *
 * These are tuned for 6400×4400 = ~28M pixel screenshots.
 * At that resolution: LOW ≈ a few chars, MEDIUM ≈ a paragraph, HIGH ≈ a section,
 * CRITICAL ≈ a full page layout shift.
 */
const SEVERITY_THRESHOLDS = {
  critical: 2.0,
  high:     0.5,
  medium:   0.05,
};

/**
 * Returns severity level + ARGB hex colour for Excel highlighting.
 * @param {number} mismatch     number of differing pixels
 * @param {number} totalPixels  total pixels in the image
 */
function getSeverity(mismatch, totalPixels) {
  const pct = (mismatch / totalPixels) * 100;
  if (pct > SEVERITY_THRESHOLDS.critical) return { level: "Critical", pct, argb: "FFFF4444" };
  if (pct > SEVERITY_THRESHOLDS.high)     return { level: "High",     pct, argb: "FFFF8800" };
  if (pct > SEVERITY_THRESHOLDS.medium)   return { level: "Medium",   pct, argb: "FFFFFF00" };
  return                                         { level: "Low",      pct, argb: "FF90EE90" };
}

/**
 * Compares the latest actual screenshot against the stored baseline.
 *
 * @param {object} params
 * @param {string} params.name             - Snapshot name
 * @param {number} [params.threshold=0.2]  - per-pixel color threshold (0–1)
 *
 * @returns {{ status, name, mismatch?, mismatchPercent?, ignoredAsNoise? }}
 *   status values:
 *     "baseline_created" – first run; actual promoted to baseline
 *     "size_mismatch"    – image dimensions differ
 *     "noise_ignored"    – diff found but below MIN_MISMATCH_PIXELS threshold
 *     "compared"         – real diff found; check mismatch / mismatchPercent
 */
function compareSnapshot({ name, threshold = PIXELMATCH_OPTIONS.threshold, BASELINE_DIR = DEFAULT_BASELINE_DIR, ACTUAL_DIR = DEFAULT_ACTUAL_DIR, DIFF_DIR = DEFAULT_DIFF_DIR }) {
  const safeName     = name.replace(/[/\\]/g, path.sep);
  const actualPath   = path.join(ACTUAL_DIR,   `${safeName}.png`);
  const baselinePath = path.join(BASELINE_DIR, `${safeName}.png`);
  const diffPath     = path.join(DIFF_DIR,     `${safeName}.png`);

  if (!fs.existsSync(actualPath)) {
    throw new Error(`Actual screenshot not found: ${actualPath}`);
  }

  if (!fs.existsSync(baselinePath)) {
    ensureDir(baselinePath);
    fs.copyFileSync(actualPath, baselinePath);
    removeIfExists(diffPath);
    return { status: "baseline_created", name };
  }

  const img1 = PNG.sync.read(fs.readFileSync(baselinePath));
  const img2 = PNG.sync.read(fs.readFileSync(actualPath));

  if (img1.width !== img2.width || img1.height !== img2.height) {
    removeIfExists(diffPath);
    return {
      status:   "size_mismatch",
      name,
      baseline: { width: img1.width,  height: img1.height },
      actual:   { width: img2.width,  height: img2.height },
    };
  }

  const diff        = new PNG({ width: img1.width, height: img1.height });
  const totalPixels = img1.width * img1.height;
  const mismatch    = pixelmatch(
    img1.data, img2.data, diff.data,
    img1.width, img1.height,
    { ...PIXELMATCH_OPTIONS, threshold }
  );

  // Images are identical — return early with a clean "matched" status
  if (mismatch === 0) {
    removeIfExists(diffPath);
    return { status: "matched", name, mismatch: 0, mismatchPercent: "0.0000%" };
  }

  // Suppress rendering noise — only treat as a real diff if enough pixels differ
  if (mismatch < MIN_MISMATCH_PIXELS) {
    removeIfExists(diffPath);
    return { status: "noise_ignored", name, mismatch, mismatchPercent: "< noise threshold" };
  }

  const severity        = getSeverity(mismatch, totalPixels);
  const mismatchPercent = severity.pct.toFixed(4);

  ensureDir(diffPath);
  const composite = createSideBySide(img1, img2, diff);
  fs.writeFileSync(diffPath, composite);

  return {
    status:          "compared",
    name,
    mismatch,
    totalPixels,
    mismatchPercent: `${mismatchPercent}%`,
    severity:        severity.level,
    severityArgb:    severity.argb,
  };
}

/**
 * Promotes the current actual screenshot to become the new baseline.
 * Use this when UI changes are intentional and you want to accept the new look.
 *
 * @param {object} params
 * @param {string} params.name - Snapshot name (same value passed to cy.matchSnapshot)
 */
function updateBaseline({ name, BASELINE_DIR = DEFAULT_BASELINE_DIR, ACTUAL_DIR = DEFAULT_ACTUAL_DIR }) {
  const safeName     = name.replace(/[/\\]/g, path.sep);
  const actualPath   = path.join(ACTUAL_DIR,   `${safeName}.png`);
  const baselinePath = path.join(BASELINE_DIR, `${safeName}.png`);

  if (!fs.existsSync(actualPath)) {
    throw new Error(`Actual screenshot not found: ${actualPath}`);
  }
  ensureDir(baselinePath);
  fs.copyFileSync(actualPath, baselinePath);
  return { status: "baseline_updated", name };
}

/**
 * Factory — returns task functions bound to the provided directory options.
 * Called by plugin.js so consuming projects can override default paths.
 * Uses closures rather than module-level mutation so multiple configs
 * in the same process (e.g. monorepos) work independently.
 */
function makeSnapshotTasks(options = {}) {
  const BASELINE_DIR = options.baselineDir || DEFAULT_BASELINE_DIR;
  const ACTUAL_DIR   = options.actualDir   || DEFAULT_ACTUAL_DIR;
  const DIFF_DIR     = options.diffDir     || DEFAULT_DIFF_DIR;
  return {
    compareSnapshot: (params) => compareSnapshot({ ...params, BASELINE_DIR, ACTUAL_DIR, DIFF_DIR }),
    updateBaseline:  (params) => updateBaseline({ ...params, BASELINE_DIR, ACTUAL_DIR }),
  };
}

module.exports = { makeSnapshotTasks, compareSnapshot, updateBaseline };
