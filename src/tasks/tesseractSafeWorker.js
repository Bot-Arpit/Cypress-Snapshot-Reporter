"use strict";

/**
 * Tesseract worker bootstrap that forces a crash-free WASM core.
 *
 * tesseract.js v7 picks its WASM core inside a `worker_threads` worker by
 * probing CPU/WASM features with `wasm-feature-detect`. On Node 24 the V8
 * `WebAssembly.validate()` check reports relaxed-SIMD support as available, so
 * tesseract loads the relaxed-SIMD core — which then aborts at runtime with a
 * `DotProductSSE` WASM error, killing the whole process (and, when run inline,
 * Cypress with it).
 *
 * The node worker ignores the `corePath` option entirely, so the only reliable
 * way to pin a safe core is to run in the worker thread BEFORE tesseract's core
 * probe module is required, and make the relaxed-SIMD probe report `false`. That
 * falls back to the plain SIMD core, which is stable on Node 24. Set
 * `CSR_OCR_DISABLE_SIMD=1` to also disable plain SIMD and fall all the way back
 * to the non-SIMD core (slowest, most conservative).
 *
 * This file is used via the `workerPath` option of `createWorker`, so it runs
 * as the worker thread's entry point. It patches the probe, then delegates to
 * tesseract's real node worker script.
 */

try {
  const featureDetect = require("wasm-feature-detect");
  const off = async () => false;

  // The relaxed-SIMD core is the one that crashes on Node 24.
  featureDetect.relaxedSimd = off;

  // Opt-in escape hatch: disable plain SIMD too for maximum safety.
  if (process.env.CSR_OCR_DISABLE_SIMD === "1") {
    featureDetect.simd = off;
  }
} catch (e) {
  // If the probe module can't be patched for any reason, fall through. Tesseract
  // will still attempt to load, and the OCR task wraps everything in try/catch,
  // so a failure here degrades gracefully rather than crashing the run.
}

const path = require("path");

// Resolve tesseract's real node worker script relative to the installed
// package (works whether this plugin is used from source or from node_modules).
const tesseractRoot = path.dirname(require.resolve("tesseract.js/package.json"));
const workerScript = path.join(tesseractRoot, "src", "worker-script", "node", "index.js");

require(workerScript);
