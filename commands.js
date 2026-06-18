"use strict";

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

Cypress.Commands.add("matchSnapshot", { prevSubject: "optional" }, (subject, name, options = {}) => {
  const threshold = options.threshold ?? Cypress.env("snapshotThreshold") ?? 0.1;
  const failOnDiff = options.failOnDiff ?? Cypress.env("failOnSnapshotDiff") ?? false;
  const runOcr = options.runOcr ?? true;
  const autoUpdate = options.updateBaseline ?? Cypress.env("snapshotUpdateBaseline") ?? false;
  const diffDir = options.diffDir ?? Cypress.env("snapshotDiffDir") ?? "cypress/snapshots/diff";

  if (!name) throw new Error("matchSnapshot requires a name");

  const safeName = name.replace(/\\/g, "/").replace(/\/$/, "");

  cy.wait(100);
  cy.screenshot(safeName, { capture: "fullPage", overwrite: true });

  cy.task("compareSnapshot", { name: safeName, threshold }, { timeout: 30000 }).then((result) => {
    cy.log(
      `[snapshot] ${result.name} → ${result.status}` +
      (result.severity ? ` | ${result.severity}` : "") +
      (result.mismatchPercent ? ` | ${result.mismatchPercent}` : "")
    );

    if (result.status === "baseline_created") {
      addContext("Snapshot", `Baseline created: ${name}`);
    }

    if (result.status === "size_mismatch") {
      addContext("Size Mismatch", `${result.baseline.width}×${result.baseline.height} vs ${result.actual.width}×${result.actual.height}`);
    }

    const hasDiff = result.status === "compared" && result.mismatch > 0;

    if (hasDiff) {
      addContext(`Severity: ${result.severity}`, `${result.mismatch} pixels (${result.mismatchPercent})`);
      addContext("Diff Image", toReportPath(diffDir, safeName));
    }

    if (hasDiff && runOcr) {
      cy.task("ocrDiffRegions", {
        name: safeName,
        mismatch: result.mismatch,
        totalPixels: result.totalPixels,
        severity: result.severity,
      }).then((ocr) => {
        cy.log(`[ocr] ${ocr.status}`);

        if (ocr.status === "success") {
          cy.log(`[ocr] ${ocr.regionsProcessed} regions → ${ocr.excelPath}`);
          ocr.results.forEach((r, i) => {
            addContext(`Region ${i + 1} [${result.severity}]`, `${r.contentType} | ${r.confidence}%`);
            addContext(`Region ${i + 1} Baseline`, r.baselineText || "(no text)");
            addContext(`Region ${i + 1} Actual`, r.actualText || "(no text)");
          });
          addContext("Excel Report", ocr.excelPath);
        } else {
          addContext("OCR", ocr.status);
        }
      });
    }

    if (autoUpdate && ["matched", "noise_ignored", "compared", "size_mismatch"].includes(result.status)) {
      cy.task("updateBaseline", { name: safeName }).then(() => {
        cy.log(`[snapshot] baseline updated: ${name}`);
        addContext("Snapshot", `Updated: ${name}`);
      });
    }

    if (hasDiff && failOnDiff) {
      throw new Error(`[${result.severity}] Mismatch "${name}": ${result.mismatchPercent}`);
    }
  });
});
