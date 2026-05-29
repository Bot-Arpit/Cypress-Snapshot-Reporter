const fs      = require("fs");
const path    = require("path");
const { PNG } = require("pngjs");
const XlsxPopulate = require("xlsx-populate");
const { COMPOSITE_SEP } = require("./constants"); // single source of truth

const DEFAULT_BASELINE_DIR = "cypress/snapshots/baseline";
const DEFAULT_ACTUAL_DIR   = "cypress/snapshots/actual";
const DEFAULT_DIFF_DIR     = "cypress/snapshots/diff";
const DEFAULT_EXCEL_FILE   = "cypress/snapshots/reports/diff-report.xlsx";

/**
 * Minimum area (width × height in pixels) for a diff region to be OCR-processed.
 *
 * Set low enough to catch a single changed digit:
 *   - A digit at report font size (~14px) is roughly 8px wide × 16px tall = 128px²
 *   - Adding the 10px padding on each side: ~28×36 = ~1008px² bounding box
 *   - So 100px² safely catches any single-character change after padding is applied
 *
 * Filters out only truly isolated 1-3 pixel rendering glitches (< 100px²).
 */
const MIN_REGION_AREA = 100;

// ─── Tesseract worker singleton ───────────────────────────────────────────────
// The worker is created once on first use and reused for all subsequent OCR calls
// within the same Cypress task process. This avoids reloading the 12MB language
// model on every snapshot diff.

let _tesseractWorker     = null;

async function getWorker() {
  if (_tesseractWorker) return _tesseractWorker;

  const { createWorker } = require("tesseract.js");
  _tesseractWorker = await createWorker("eng", 1, {
    langPath: path.join(__dirname, "../tessdata"),
  });
  return _tesseractWorker;
}

// Clean up on process exit so Cypress doesn't hang
process.on("exit", () => {
  if (_tesseractWorker) {
    _tesseractWorker.terminate().catch(() => {});
    _tesseractWorker = null;
  }
});

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Resolves screenshot path robustly:
 * 1) Direct path:   <dir>/<name>.png
 * 2) Nested path:   <dir>/<any-subfolder>/<name>.png
 *    (Cypress often adds a spec-name folder)
 * Picks the newest nested match when multiple files exist.
 */
function resolveScreenshotPath(dir, safeName) {
  const directPath = path.join(dir, `${safeName}.png`);
  if (fs.existsSync(directPath)) return directPath;
  if (!fs.existsSync(dir)) return null;

  const tail = `${path.sep}${safeName}.png`.toLowerCase();
  let bestMatch = null;
  let bestMtime = -1;

  const walk = (currentDir) => {
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
  };

  walk(dir);
  return bestMatch;
}

// ─── Region detection ─────────────────────────────────────────────────────────

function extractDiffRegions(diffBuffer, gapTolerance = 5, padding = 10) {
  const img = PNG.sync.read(diffBuffer);
  const { width, height, data } = img;

  const rowBounds = new Array(height).fill(null);
  for (let y = 0; y < height; y++) {
    let minX = Infinity, maxX = -Infinity;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i] > 200 && data[i + 1] < 80 && data[i + 2] < 80) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (minX !== Infinity) rowBounds[y] = { minX, maxX };
  }

  const groups = [];
  let group = null;
  for (let y = 0; y <= height; y++) {
    if (y < height && rowBounds[y]) {
      if (!group) {
        group = { y1: y, y2: y, minX: rowBounds[y].minX, maxX: rowBounds[y].maxX };
      } else {
        group.y2 = y;
        if (rowBounds[y].minX < group.minX) group.minX = rowBounds[y].minX;
        if (rowBounds[y].maxX > group.maxX) group.maxX = rowBounds[y].maxX;
      }
    } else if (group) {
      // Look ahead: check rows y+1 … y+gapTolerance for more red content.
      // (y+gap-1 was the previous off-by-one bug — it checked the current null row)
      let bridged = false;
      for (let gap = 1; gap <= gapTolerance && y + gap < height; gap++) {
        if (rowBounds[y + gap]) { bridged = true; break; }
      }
      if (!bridged) { groups.push(group); group = null; }
    }
  }

  return groups.map((g) => {
    const x = Math.max(0, g.minX - padding);
    const y = Math.max(0, g.y1   - padding);
    return {
      x,
      y,
      width:  Math.min(width  - x, g.maxX - g.minX + padding * 2),
      height: Math.min(height - y, g.y2   - g.y1   + padding * 2),
    };
  });
}

function toSingleImageCoords(compositeRegions, panelWidth) {
  const panelOffset = panelWidth + COMPOSITE_SEP;
  return compositeRegions
    .map((r) => {
      const adjX     = Math.max(0, r.x - panelOffset);
      const adjWidth = Math.min(panelWidth - adjX, r.width);
      return { x: adjX, y: r.y, width: adjWidth, height: r.height };
    })
    .filter((r) => r.width > 0 && r.height > 0);
}

/**
 * Crops a region from a pre-parsed PNG object (avoids re-parsing on every call).
 * Use this inside loops where the same source image is cropped multiple times.
 */
function cropRegionFromParsed(src, { x, y, width, height }) {
  const dst = new PNG({ width, height });
  for (let row = 0; row < height; row++) {
    for (let col = 0; col < width; col++) {
      const si = ((y + row) * src.width + (x + col)) * 4;
      const di = (row * width + col) * 4;
      dst.data[di]     = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
  return PNG.sync.write(dst);
}

// ─── Table detection & comparison ────────────────────────────────────────────

/**
 * Checks Tesseract block data to determine if the region contains a table.
 * Falls back to heuristic (multiple aligned columns in text) if no blocks.
 */
function detectContentType(blocks, text) {
  if (blocks && blocks.length > 0) {
    if (blocks.some((b) => b.blocktype === "TABLE")) return "Table";
  }
  // Heuristic: if multiple lines have 2+ whitespace-separated columns, treat as table
  const lines = text.split("\n").filter((l) => l.trim());
  const columnLines = lines.filter((l) => /\s{2,}/.test(l.trim())).length;
  if (lines.length >= 2 && columnLines / lines.length >= 0.5) return "Table";
  return "Text";
}

/**
 * Splits a text line into cells using 2+ consecutive spaces as column separator.
 */
function splitRowToCells(line) {
  return line.trim().split(/\s{2,}/).map((c) => c.trim()).filter(Boolean);
}

/**
 * Compares two multi-line OCR texts row by row (and cell by cell for tables).
 * Returns an array of human-readable diff strings.
 *
 * @returns {{ rowDiffs: string[], changedValuesText: string }}
 */
function compareTableRows(baselineText, actualText) {
  const baseRows   = baselineText.split("\n").map((r) => r.trim()).filter(Boolean);
  const actualRows = actualText.split("\n").map((r) => r.trim()).filter(Boolean);
  const maxRows    = Math.max(baseRows.length, actualRows.length);
  const rowDiffs   = [];

  for (let i = 0; i < maxRows; i++) {
    const bRow = baseRows[i]  || "";
    const aRow = actualRows[i] || "";
    if (bRow === aRow) continue;

    const bCells = splitRowToCells(bRow);
    const aCells = splitRowToCells(aRow);

    if (bCells.length > 1 || aCells.length > 1) {
      // Cell-level diff within the row
      const maxCells = Math.max(bCells.length, aCells.length);
      for (let j = 0; j < maxCells; j++) {
        const bCell = bCells[j] || "(empty)";
        const aCell = aCells[j] || "(empty)";
        if (bCell !== aCell) {
          rowDiffs.push(`Row ${i + 1}, Col ${j + 1}: "${bCell}" → "${aCell}"`);
        }
      }
    } else {
      rowDiffs.push(`Row ${i + 1}: "${bRow}" → "${aRow}"`);
    }
  }

  return {
    rowDiffs,
    changedValuesText: rowDiffs.length > 0 ? rowDiffs.join("\n") : "—",
  };
}

/**
 * Generates a natural-language comment describing what changed.
 */
function generateComment(contentType, baselineText, actualText, rowDiffs) {
  const bTrimmed = (baselineText || "").trim();
  const aTrimmed = (actualText   || "").trim();

  if (!bTrimmed && !aTrimmed) {
    return "No readable text detected in this region. The change may be graphical (chart, image, or colour).";
  }
  if (!bTrimmed) {
    return `New content appeared: "${aTrimmed.substring(0, 120)}".`;
  }
  if (!aTrimmed) {
    return `Content was removed. Previous value: "${bTrimmed.substring(0, 120)}".`;
  }
  if (bTrimmed === aTrimmed) {
    return "Text content is identical despite a visual difference. This may be a colour, font, or formatting change.";
  }

  if (contentType === "Table") {
    if (rowDiffs.length === 0) {
      return "A table was detected. Row content appears the same — difference may be in borders or cell formatting.";
    }
    if (rowDiffs.length === 1) {
      return `Table changed: ${rowDiffs[0]}.`;
    }
    return `Table changed in ${rowDiffs.length} place(s). First: ${rowDiffs[0]}.`;
  }

  // Plain text diff
  const preview = (s) => s.length > 80 ? s.substring(0, 80) + "…" : s;
  return `Text changed from "${preview(bTrimmed)}" to "${preview(aTrimmed)}".`;
}

// ─── Severity helpers ─────────────────────────────────────────────────────────

const SEVERITY_ARGB = {
  Critical: "FFFF4444",
  High:     "FFFF8800",
  Medium:   "FFFFFF00",
  Low:      "FF90EE90",
};

/** Returns a lighter tint of the severity colour for the row background. */
const SEVERITY_ROW_ARGB = {
  Critical: "FFFFCCCC",
  High:     "FFFFEAD9",
  Medium:   "FFFFFFCC",
  Low:      "FFE9F7E9",
};

// ─── Excel output ─────────────────────────────────────────────────────────────

const REPORT_COLUMNS = [
  { header: "Severity",            width: 12 },
  { header: "Snapshot Name",       width: 45 },
  { header: "Content Type",        width: 14 },
  { header: "OCR Text (Baseline)", width: 48 },
  { header: "OCR Text (Actual)",   width: 48 },
  { header: "Changed Values",      width: 55 },
  { header: "Confidence %",        width: 14 },
  { header: "Comment",             width: 65 },
  { header: "Run Date",            width: 22 },
];

function argbToRgb(argb, fallback = "FFFFFF") {
  if (typeof argb !== "string" || argb.length < 6) return fallback;
  return argb.slice(-6);
}

async function writeOcrToExcel(snapshotName, ocrResults, severity, EXCEL_FILE = DEFAULT_EXCEL_FILE) {
  ensureDir(EXCEL_FILE);

  const workbook = fs.existsSync(EXCEL_FILE)
    ? await XlsxPopulate.fromFileAsync(EXCEL_FILE)
    : await XlsxPopulate.fromBlankAsync();

  let sheet = workbook.sheet("Diff Report");
  if (!sheet) {
    sheet = workbook.addSheet("Diff Report");

    // Remove default empty sheet when creating a new workbook.
    const defaultSheet = workbook.sheet("Sheet1");
    if (defaultSheet && defaultSheet.name() !== "Diff Report") {
      workbook.deleteSheet(defaultSheet.name());
    }

    REPORT_COLUMNS.forEach((col, index) => {
      const c = index + 1;
      sheet.cell(1, c).value(col.header).style({
        bold: true,
        fontColor: "FFFFFF",
        fill: "2F5496",
        horizontalAlignment: "center",
        verticalAlignment: "center",
        wrapText: true,
      });
      sheet.column(c).width(col.width);
    });
  }

  const usedRange = sheet.usedRange();
  let rowNum = usedRange ? usedRange.endCell().rowNumber() + 1 : 2;
  if (rowNum < 2) rowNum = 2;

  const date        = new Date().toLocaleString("en-GB");
  const rowBgColor   = argbToRgb(SEVERITY_ROW_ARGB[severity], "FFFFFF");
  const sevBadgeColor = argbToRgb(SEVERITY_ARGB[severity], "FFFFFF");

  for (const r of ocrResults) {
    const rowValues = [
      severity,
      snapshotName,
      r.contentType,
      r.baselineText || "(no text detected)",
      r.actualText || "(no text detected)",
      r.changedValues || "—",
      `${r.confidence.toFixed(1)}%`,
      r.comment,
      date,
    ];

    rowValues.forEach((value, index) => {
      sheet.cell(rowNum, index + 1).value(value).style({
        wrapText: true,
        verticalAlignment: "top",
        fill: rowBgColor,
      });
    });

    // Severity badge cell.
    sheet.cell(rowNum, 1).style({
      bold: true,
      fill: sevBadgeColor,
      horizontalAlignment: "center",
      verticalAlignment: "center",
    });

    // Table type cell.
    if (r.contentType === "Table") {
      sheet.cell(rowNum, 3).style({ fill: "DCE6F1" });
    }

    // Low confidence -> amber on key OCR cells.
    if (r.confidence < 60) {
      [4, 5, 7].forEach((col) => {
        sheet.cell(rowNum, col).style({ fill: "FFF2CC" });
      });
    }

    rowNum += 1;
  }

  sheet.freezePanes(2, 1);

  await workbook.toFileAsync(EXCEL_FILE);
  return EXCEL_FILE;
}

// ─── Main task ────────────────────────────────────────────────────────────────

async function ocrDiffRegions({ name, mismatch = 0, totalPixels = 0, severity = "Low", BASELINE_DIR = DEFAULT_BASELINE_DIR, ACTUAL_DIR = DEFAULT_ACTUAL_DIR, DIFF_DIR = DEFAULT_DIFF_DIR, EXCEL_FILE = DEFAULT_EXCEL_FILE }) {
  const safeName     = name.replace(/[/\\]/g, path.sep);
  const diffPath     = path.join(DIFF_DIR,     `${safeName}.png`);
  const actualPath   = resolveScreenshotPath(ACTUAL_DIR, safeName);
  const baselinePath = path.join(BASELINE_DIR, `${safeName}.png`);

  if (!fs.existsSync(diffPath))     return { status: "no_diff_image",     name, regionsProcessed: 0 };
  if (!actualPath)                  return { status: "no_actual_image",   name, regionsProcessed: 0 };
  if (!fs.existsSync(baselinePath)) return { status: "no_baseline_image", name, regionsProcessed: 0 };

  const diffBuffer     = fs.readFileSync(diffPath);
  const actualBuffer   = fs.readFileSync(actualPath);
  const baselineBuffer = fs.readFileSync(baselinePath);

  // Parse each PNG once — reused for every region crop (avoids redundant decoding)
  const actualPng    = PNG.sync.read(actualBuffer);
  const baselinePng  = PNG.sync.read(baselineBuffer);
  const panelWidth   = actualPng.width;

  const compositeRegions = extractDiffRegions(diffBuffer);
  const regions = toSingleImageCoords(compositeRegions, panelWidth)
    .filter((r) => r.width * r.height >= MIN_REGION_AREA);

  if (regions.length === 0) return { status: "no_red_regions", name, regionsProcessed: 0 };

  // Reuse the singleton worker — no re-loading of the 12MB language model
  const worker     = await getWorker();
  const ocrResults = [];

  for (const region of regions) {
    const actualCrop   = cropRegionFromParsed(actualPng,   region);
    const baselineCrop = cropRegionFromParsed(baselinePng, region);

    const actualResult   = await worker.recognize(actualCrop);
    const baselineResult = await worker.recognize(baselineCrop);

    const actualText   = actualResult.data.text.trim();
    const baselineText = baselineResult.data.text.trim();
    const confidence   = actualResult.data.confidence;
    const blocks       = actualResult.data.blocks || [];

    const contentType                    = detectContentType(blocks, actualText);
    const { rowDiffs, changedValuesText } = compareTableRows(baselineText, actualText);
    const comment                        = generateComment(contentType, baselineText, actualText, rowDiffs);

    ocrResults.push({
      region,
      contentType,
      baselineText,
      actualText,
      changedValues: changedValuesText,
      confidence,
      comment,
    });
  }
  // Worker stays alive for reuse — terminated on process exit

  const excelPath = await writeOcrToExcel(name, ocrResults, severity, EXCEL_FILE);

  return {
    status:           "success",
    name,
    regionsProcessed: ocrResults.length,
    excelPath,
    results: ocrResults.map((r) => ({
      region:       r.region,
      contentType:  r.contentType,
      baselineText: r.baselineText,
      actualText:   r.actualText,
      confidence:   `${r.confidence.toFixed(1)}%`,
      comment:      r.comment,
    })),
  };
}

/**
 * Factory — returns task functions bound to the provided directory options.
 * Called by plugin.js so consuming projects can override default paths.
 * Uses closures rather than module-level mutation so multiple configs
 * in the same process (e.g. monorepos) work independently.
 */
function makeOcrTasks(options = {}) {
  const BASELINE_DIR = options.baselineDir || DEFAULT_BASELINE_DIR;
  const ACTUAL_DIR   = options.actualDir   || DEFAULT_ACTUAL_DIR;
  const DIFF_DIR     = options.diffDir     || DEFAULT_DIFF_DIR;
  const EXCEL_FILE   = options.excelFile   || DEFAULT_EXCEL_FILE;
  return {
    ocrDiffRegions: (params) => ocrDiffRegions({ ...params, BASELINE_DIR, ACTUAL_DIR, DIFF_DIR, EXCEL_FILE }),
  };
}

module.exports = { makeOcrTasks, ocrDiffRegions };
