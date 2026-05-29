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
 */

/** Safe wrapper — only calls cy.addTestContext when cypress-mochawesome-reporter is loaded. */
function addContext(title, value) {
  if (typeof cy.addTestContext === "function") {
    cy.addTestContext({ title, value });
  }
}

Cypress.Commands.add("matchSnapshot", (name, options = {}) => {
  const threshold  = options.threshold  ?? Cypress.env("snapshotThreshold")  ?? 0.1;
  const failOnDiff = options.failOnDiff ?? Cypress.env("failOnSnapshotDiff") ?? false;
  const runOcr     = options.runOcr     ?? true;

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

      if (result.status === "compared" && result.mismatch > 0) {

        addContext(
          `Severity: ${result.severity}`,
          `${result.mismatch} pixels differ (${result.mismatchPercent} of image)`
        );

        addContext(
          "Pixel Diff Image  [ Baseline | Diff | Actual ]",
          `cypress/snapshots/diff/${name}.png`
        );

        if (runOcr) {
          cy.task("ocrDiffRegions", {
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
          });
        }

        if (failOnDiff) {
          throw new Error(
            `[${result.severity}] Snapshot mismatch for "${name}": ${result.mismatchPercent} pixels differ. ` +
            `See Mochawesome report for diff image and OCR details.`
          );
        }
      }
    });
  });
});
