import { describe, it, expect } from "vitest"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

// scripts/resolve-ledger-rebase-conflict.mjs exists because the SAME false
// positive has now fired SEVEN times: a conflict-marker check written as
// `includes("<<<<<<<")` matches docs/overnight/ledger.md's own PROSE, which
// quotes the markers while documenting this very incident. An unanchored check
// therefore rejects a CORRECT resolution, and the session then hand-edits a file
// that was already right.
//
// This test pins the property against the REAL known offender rather than a
// fixture, so it cannot go vacuous if the ledger's wording changes: it first
// asserts the offender still exists (an unanchored pattern DOES match the live
// ledger), and only then that the script's anchored pattern does NOT.
//
// ⚠ If the ledger is ever rewritten such that it no longer quotes a marker in
// prose, the first assertion fails LOUDLY rather than this test silently
// becoming a no-op. That is deliberate: at that point the hazard is gone and
// this test should be re-read, not auto-passed.

const REPO = process.cwd()
const LEDGER = path.join(REPO, "docs/overnight/ledger.md")
const SCRIPT = path.join(REPO, "scripts/resolve-ledger-rebase-conflict.mjs")

/** What git actually writes: markers at column 0. */
const ANCHORED = /^(<<<<<<< |=======$|>>>>>>> )/m
/** The bug: matches anywhere, including inside a sentence about markers. */
const UNANCHORED = /<<<<<<</

describe("the ledger rebase resolver's conflict-marker check is anchored", () => {
  it("ships the resolver script", () => {
    expect(existsSync(SCRIPT), "scripts/resolve-ledger-rebase-conflict.mjs is missing").toBe(true)
  })

  it("the known offender still exists — the live ledger quotes markers in prose", () => {
    const ledger = readFileSync(LEDGER, "utf8")
    // Non-vacuity guard: if this fails, the hazard changed shape. Re-read the
    // test rather than deleting it.
    expect(
      UNANCHORED.test(ledger),
      "docs/overnight/ledger.md no longer contains a quoted conflict marker — " +
        "the offender this test is calibrated against is gone; re-read the test",
    ).toBe(true)
  })

  it("the anchored pattern does NOT match the live ledger (no false positive)", () => {
    const ledger = readFileSync(LEDGER, "utf8")
    const offending = ledger.split(/\r?\n/).filter((l) => ANCHORED.test(l))
    expect(
      offending,
      `anchored marker check matched ${offending.length} line(s) in a clean ledger:\n` +
        offending.slice(0, 5).join("\n"),
    ).toEqual([])
  })

  it("the resolver does not use an unanchored marker check", () => {
    const src = readFileSync(SCRIPT, "utf8")
    // Strip the file's own explanatory comments before grepping, or the warning
    // ABOUT the bug reads as the bug — the same class this test exists for.
    const code = src
      .split(/\r?\n/)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n")
    expect(
      /includes\(\s*["'`]<<<<<<</.test(code),
      "resolver uses an unanchored includes('<<<<<<<') check — that is the seven-time bug",
    ).toBe(false)
    expect(/\^\(<<<<<<< /.test(code), "resolver should anchor its marker regex to line start").toBe(true)
  })
})
