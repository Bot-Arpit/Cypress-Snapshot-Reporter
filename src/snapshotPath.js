"use strict";

/**
 * Shared snapshot path helpers (Node + Cypress command layer).
 *
 * Storage layout:
 *   <baseline|actual|diff>/<specName>/<userPath>.png
 * e.g.
 *   cypress/snapshots/baseline/login.cy/Home/Header.png
 */

const path = require("path");

const WINDOWS_INVALID_CHARS = /[<>:"|?*]/g;

function sanitizeSnapshotName(name) {
  return String(name || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/$/, "")
    .replace(WINDOWS_INVALID_CHARS, "_");
}

/**
 * Spec folder = file name only (no cypress/e2e/… path).
 * "cypress/e2e/login.cy.js" → "login.cy"
 * "login.cy.ts" → "login.cy"
 */
function normalizeSpecRoot(relative) {
  const normalized = String(relative || "unknown")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");

  const base = path.posix.basename(normalized) || "unknown";

  return base
    .replace(/\.(js|ts|jsx|tsx|mjs|cjs|coffee)$/i, "")
    .replace(WINDOWS_INVALID_CHARS, "_");
}

/** Full key used for baseline/actual/diff/OCR: <specName>/<userPath> */
function buildSnapshotKey(specRelative, name) {
  const specRoot = normalizeSpecRoot(specRelative);
  const safeName = sanitizeSnapshotName(name);
  if (!safeName) throw new Error("matchSnapshot requires a name");
  return `${specRoot}/${safeName}`;
}

module.exports = {
  sanitizeSnapshotName,
  normalizeSpecRoot,
  buildSnapshotKey,
  WINDOWS_INVALID_CHARS,
};
