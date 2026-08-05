"use strict";

/**
 * Compute the viewport size used before a snapshot capture.
 * Pure helper — safe to unit-test outside Cypress.
 */
function computeFitViewportSize({
  baseWidth,
  baseHeight,
  pageWidth,
  pageHeight,
  maxWidth = 8192,
  maxHeight = 8192,
  fitToPage = true,
} = {}) {
  const baseW = Number(baseWidth) || 1280;
  const baseH = Number(baseHeight) || 800;
  const maxW = Number(maxWidth) || 8192;
  const maxH = Number(maxHeight) || 8192;

  if (!fitToPage) {
    return {
      width: Math.min(baseW, maxW),
      height: Math.min(baseH, maxH),
      fitted: false,
    };
  }

  const width = Math.min(Math.max(baseW, Number(pageWidth) || 0), maxW);
  // Height stays near the configured viewport; fullPage scrolls for tall pages.
  const height = Math.min(Math.max(baseH, Number(pageHeight) || 0), maxH);

  return {
    width,
    height,
    fitted: width > baseW || height > baseH,
  };
}

module.exports = {
  computeFitViewportSize,
};
