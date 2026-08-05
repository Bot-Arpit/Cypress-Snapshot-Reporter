"use strict";

const assert = require("assert");
const { computeFitViewportSize } = require("../src/fitViewport");

assert.deepStrictEqual(
  computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 1280,
    pageHeight: 800,
  }),
  { width: 1280, height: 800, fitted: false }
);

assert.deepStrictEqual(
  computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 2400,
    pageHeight: 800,
  }),
  { width: 2400, height: 800, fitted: true }
);

assert.deepStrictEqual(
  computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 9000,
    pageHeight: 800,
    maxWidth: 3840,
  }),
  { width: 3840, height: 800, fitted: true }
);

assert.deepStrictEqual(
  computeFitViewportSize({
    baseWidth: 1280,
    baseHeight: 800,
    pageWidth: 2400,
    pageHeight: 800,
    fitToPage: false,
  }),
  { width: 1280, height: 800, fitted: false }
);

console.log("  ok - fitViewport helpers");
console.log("\n1/1 passed");
