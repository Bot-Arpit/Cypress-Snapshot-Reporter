/**
 * cypress-snapshot-reporter/commands
 *
 * Registers the cy.matchSnapshot() command.
 * Import this in your cypress/support/e2e.js:
 *
 *   import "cypress-snapshot-reporter/commands";
 *
 * Options for cy.matchSnapshot(name, options):
 *   threshold  {number}   0–1 pixelmatch sensitivity    default: 0.1
 *   failOnDiff {boolean}  fail test on pixel diff       default: false
 *   runOcr     {boolean}  run OCR + write Excel on diff default: true
 *   updateBaseline {boolean} auto-promote actual -> baseline after compare
 *   diffDir        {string}  custom diff folder for reporter context links
 */

/** Safe wrapper — only calls cy.addTestContext when cypress-mochawesome-reporter is loaded. */
function addContext(title, value) {
  if (typeof cy.addTestContext === "function") {
    cy.addTestContext({ title, value });
  }
}

function toReportPath(baseDir, snapshotName) {
  const base = String(baseDir || "").replace(/\\/g, "/").replace(/\/+$/, "");
  const name = String(snapshotName || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return `${base}/${name}.png`;
}

Cypress.Commands.add("matchSnapshot", (name, options = {}) => {
  const threshold          = options.threshold      ?? Cypress.env("snapshotThreshold")     ?? 0.1;
  const failOnDiff         = options.failOnDiff     ?? Cypress.env("failOnSnapshotDiff")    ?? false;
  const runOcr             = options.runOcr          ?? true;
  const autoUpdateBaseline = options.updateBaseline  ?? Cypress.env("snapshotUpdateBaseline") ?? false;
  const diffDir            = options.diffDir         ?? Cypress.env("snapshotDiffDir")       ?? "cypress/snapshots/diff";

  cy.screenshot(name, { capture: "fullPage", overwrite: true }).then(() => {
    cy.task("compareSnapshot", { name, threshold }).then((result) => {

      cy.log(
        `[snapshot] ${result.name} → ${result.status}` +
        (result.severity        ? ` | severity: ${result.severity}`         : "") +
        (result.mismatchPercent ? ` | diff: ${result.mismatchPercent}`      : "")
      );

      if (result.status === "baseline_created") {
        addContext("Snapshot", `Baseline created for: ${name}`);
      }

      if (result.status === "noise_ignored") {
        cy.log(`[snapshot] ${result.name} — ${result.mismatch} pixel(s) below noise threshold, ignored`);
      }

      if (result.status === "size_mismatch") {
        addContext(
          "Snapshot Size Mismatch",
          `Baseline: ${result.baseline.width}×${result.baseline.height} | Actual: ${result.actual.width}×${result.actual.height}`
        );
      }

      const hasRealDiff = result.status === "compared" && result.mismatch > 0;

      if (hasRealDiff) {

        addContext(
          `Severity: ${result.severity}`,
          `${result.mismatch} pixels differ (${result.mismatchPercent} of image)`
        );

        addContext(
          "Pixel Diff Image  [ Baseline | Diff | Actual ]",
          toReportPath(diffDir, name)
        );
      }

      let chain = cy.wrap(null, { log: false });

      if (hasRealDiff && runOcr) {
        chain = chain.then(() => cy.task("ocrDiffRegions", {
            name,
            mismatch:    result.mismatch,
            totalPixels: result.totalPixels,
            severity:    result.severity,
          }).then((ocrResult) => {
            cy.log(`[ocr] ${ocrResult.status}`);

            if (ocrResult.status === "success") {
              cy.log(`[ocr] ${ocrResult.regionsProcessed} region(s) → ${ocrResult.excelPath}`);

              ocrResult.results.forEach((r, i) => {
                addContext(
                  `Region ${i + 1} — [${result.severity}] ${r.contentType}  |  Conf: ${r.confidence}`,
                  r.comment
                );
                addContext(`Region ${i + 1} — Baseline Text`, r.baselineText || "(no text detected)");
                addContext(`Region ${i + 1} — Actual Text`,   r.actualText   || "(no text detected)");
              });

              addContext("Full OCR Diff Report (Excel)", ocrResult.excelPath);
            } else {
              addContext("OCR skipped", ocrResult.status);
            }
          }));
      }

      const shouldAutoUpdate = autoUpdateBaseline && (
        result.status === "matched" ||
        result.status === "noise_ignored" ||
        result.status === "compared"
      );

      if (shouldAutoUpdate) {
        chain = chain.then(() => cy.task("updateBaseline", { name }).then(() => {
          cy.log(`[snapshot] baseline updated for ${name}`);
          addContext("Snapshot", `Baseline updated for: ${name}`);
        }));
      }

      return chain.then(() => {
        if (hasRealDiff && failOnDiff) {
          throw new Error(
            `[${result.severity}] Snapshot mismatch for "${name}": ${result.mismatchPercent} pixels differ. ` +
            `See Mochawesome report for diff image and OCR details.`
          );
        }
      });
    });
  });
});
