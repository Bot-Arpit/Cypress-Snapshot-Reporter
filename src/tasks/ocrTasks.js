const fs      = require("fs");
const path    = require("path");
const { PNG } = require("pngjs");
const ExcelJS = require("exceljs");
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
let _tesseractWorkerBusy = false;

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

async function writeOcrToExcel(snapshotName, ocrResults, severity, EXCEL_FILE = DEFAULT_EXCEL_FILE) {
  ensureDir(EXCEL_FILE);

  const workbook = new ExcelJS.Workbook();
  if (fs.existsSync(EXCEL_FILE)) {
    await workbook.xlsx.readFile(EXCEL_FILE);
  }

  let sheet = workbook.getWorksheet("Diff Report");
  if (!sheet) {
    sheet = workbook.addWorksheet("Diff Report");
    sheet.columns = [
      { header: "Severity",            key: "severity",      width: 12 },
      { header: "Snapshot Name",       key: "name",          width: 45 },
      { header: "Content Type",        key: "contentType",   width: 14 },
      { header: "OCR Text (Baseline)", key: "baselineText",  width: 48 },
      { header: "OCR Text (Actual)",   key: "actualText",    width: 48 },
      { header: "Changed Values",      key: "changedValues", width: 55 },
      { header: "Confidence %",        key: "confidence",    width: 14 },
      { header: "Comment",             key: "comment",       width: 65 },
      { header: "Run Date",            key: "date",          width: 22 },
    ];

    const headerRow = sheet.getRow(1);
    headerRow.eachCell((cell) => {
      cell.font      = { bold: true, color: { argb: "FFFFFFFF" } };
      cell.fill      = { type: "pattern", pattern: "solid", fgColor: { argb: "FF2F5496" } };
      cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
      cell.border    = { bottom: { style: "medium", color: { argb: "FF000000" } } };
    });
    headerRow.height = 22;
  }

  const date        = new Date().toLocaleString("en-GB");
  const rowBgArgb   = SEVERITY_ROW_ARGB[severity] || "FFFFFFFF";
  const sevBadgeArgb = SEVERITY_ARGB[severity]    || "FFFFFFFF";

  for (const r of ocrResults) {
    const row = sheet.addRow({
      severity:      severity,
      name:          snapshotName,
      contentType:   r.contentType,
      baselineText:  r.baselineText  || "(no text detected)",
      actualText:    r.actualText    || "(no text detected)",
      changedValues: r.changedValues || "—",
      confidence:    `${r.confidence.toFixed(1)}%`,
      comment:       r.comment,
      date,
    });

    row.alignment = { wrapText: true, vertical: "top" };

    // Tint entire row with severity colour
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: rowBgArgb } };
    });

    // Severity badge cell — bold + saturated severity colour
    const sevCell = row.getCell("severity");
    sevCell.font  = { bold: true };
    sevCell.fill  = { type: "pattern", pattern: "solid", fgColor: { argb: sevBadgeArgb } };
    sevCell.alignment = { horizontal: "center", vertical: "middle" };

    // Table type → blue badge
    if (r.contentType === "Table") {
      row.getCell("contentType").fill = {
        type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" },
      };
    }

    // Low confidence → amber on OCR text cells (overrides row tint)
    if (r.confidence < 60) {
      ["baselineText", "actualText", "confidence"].forEach((key) => {
        row.getCell(key).fill = {
          type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" },
        };
      });
    }
  }

  sheet.views = [{ state: "frozen", ySplit: 1 }];

  await workbook.xlsx.writeFile(EXCEL_FILE);
  return EXCEL_FILE;
}

// ─── Main task ────────────────────────────────────────────────────────────────

async function ocrDiffRegions({ name, mismatch = 0, totalPixels = 0, severity = "Low", BASELINE_DIR = DEFAULT_BASELINE_DIR, ACTUAL_DIR = DEFAULT_ACTUAL_DIR, DIFF_DIR = DEFAULT_DIFF_DIR, EXCEL_FILE = DEFAULT_EXCEL_FILE }) {
  const safeName     = name.replace(/[/\\]/g, path.sep);
  const diffPath     = path.join(DIFF_DIR,     `${safeName}.png`);
  const actualPath   = path.join(ACTUAL_DIR,   `${safeName}.png`);
  const baselinePath = path.join(BASELINE_DIR, `${safeName}.png`);

  if (!fs.existsSync(diffPath))     return { status: "no_diff_image",     name, regionsProcessed: 0 };
  if (!fs.existsSync(actualPath))   return { status: "no_actual_image",   name, regionsProcessed: 0 };
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
