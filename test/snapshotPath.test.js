"use strict";

const assert = require("assert");
const {
  sanitizeSnapshotName,
  normalizeSpecRoot,
  buildSnapshotKey,
} = require("../src/snapshotPath");

assert.strictEqual(sanitizeSnapshotName(" Home/Header "), "Home/Header");
assert.strictEqual(sanitizeSnapshotName("A\\B"), "A/B");
assert.strictEqual(sanitizeSnapshotName('bad<>:"|?*name'), "bad_______name");

assert.strictEqual(normalizeSpecRoot("cypress/e2e/login.cy.js"), "login.cy");
assert.strictEqual(normalizeSpecRoot("cypress\\e2e\\login.cy.ts"), "login.cy");
assert.strictEqual(normalizeSpecRoot("./cypress/e2e/a.cy.jsx"), "a.cy");
assert.strictEqual(normalizeSpecRoot("login.cy.js"), "login.cy");

assert.strictEqual(
  buildSnapshotKey("cypress/e2e/login.cy.js", "Home/Header"),
  "login.cy/Home/Header"
);

console.log("  ok - snapshotPath helpers");
console.log("\n1/1 passed");
