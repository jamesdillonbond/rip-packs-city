import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "fs"
import { resolve } from "path"

// The live-drift check (scripts/check-db-pin-staleness.mjs) is the ONLY thing
// that can catch a pinned data-integrity function whose LIVE prod definition
// drifted (the in-CI drift guard is repo-vs-repo and structurally cannot). It
// re-derives the pin list from the drift-guard file with a regex — and on
// 2026-08-08 that regex was found to SILENTLY DROP any PINS entry carrying a
// comment between its fields (a "re-pointed 2026-…" note). Two data-critical
// pins — get_wallet_moments_with_fmv and get_team_detail — were invisible to the
// live check for exactly that reason.
//
// This test reads the script's ACTUAL regex (single source of truth — not a
// duplicate) and asserts it captures EVERY pin the guard defines, so a future
// tightening of the parser can never again silently shrink live-drift coverage.

const GUARD = resolve(process.cwd(), "__tests__/db-invariants-drift-guard.test.ts")
const SCRIPT = resolve(process.cwd(), "scripts/check-db-pin-staleness.mjs")

// The true pin count: every `fn:` field inside the PINS array. The drift-guard
// itself validates the array shape, so counting fn: keys here is authoritative.
function truePinCount(src: string): number {
  return (src.match(/^\s*fn:\s*"/gm) ?? []).length
}

// Extract the exact regex LITERAL the script uses to parse pins, so this test
// validates whatever the script actually runs — not a copy that could drift.
function scriptPinRegex(scriptSrc: string): RegExp {
  const m = scriptSrc.match(/const re = (\/.*\/g)\s*\n/)
  if (!m) throw new Error("could not locate the pin-parsing regex in check-db-pin-staleness.mjs")
  // eslint-disable-next-line no-eval
  return eval(m[1]) as RegExp
}

describe("db-pin staleness parser coverage", () => {
  it("the staleness script's regex captures every pin the drift guard defines", () => {
    const guardSrc = readFileSync(GUARD, "utf-8")
    const scriptSrc = readFileSync(SCRIPT, "utf-8")

    const expected = truePinCount(guardSrc)
    expect(expected).toBeGreaterThan(100) // sanity: the pin set is large

    const re = scriptPinRegex(scriptSrc)
    const captured = [...guardSrc.matchAll(re)].length

    // If this fails, a PINS entry (likely one carrying a comment between its
    // fields) is NOT being live-drift-checked. Loosen the script's regex, don't
    // lower this expectation.
    expect(captured).toBe(expected)
  })
})

// ── EVERY copy of the DDL extractor must handle PROCEDURE, not just FUNCTION ──
//
// There are THREE copies of this parser in the repo and they are supposed to
// mirror each other. On 2026-08-16 the drift guard learned about PROCEDURE,
// recording that a FUNCTION-only needle "made every PROCEDURE in this database
// UNPINNABLE". The other two did not get the fix:
//
//   * scripts/check-db-pin-staleness.mjs — its own comment says it "mirrors the
//     guard's own parser". For six days it did not. The consequence was NOT a
//     loud failure: `reconcile_all_saved_wallet_stats` is a PROCEDURE, so its DDL
//     could never be extracted, the pin reported NO_DDL_IN_MIGRATION on every run,
//     and the live-drift comparison for it NEVER RAN — on a procedure that writes
//     the cached portfolio figures every collector sees on their saved wallets.
//     It sat in the PINS array looking covered the entire time.
//   * scripts/verify-live-ddl.mjs — its header claimed it "extracts the fn DDL
//     exactly as db-invariants-drift-guard.test.ts does". It did not.
//
// ⚠ The file set is DERIVED BY SCANNING, not listed. CLAUDE.md records that a
// guard naming its instances dies on a rename, and a curated list here would also
// miss a FOURTH copy — which is exactly how the third one was found (by grepping
// the expression, not the file). The scan carries its own floor: if it stops
// finding at least the three known copies, the detector has broken and the test
// fails rather than passing on an empty population.
describe("every DDL-extractor copy handles PROCEDURE", () => {
  // A file builds a DDL needle if it interpolates `public.${...}` into a
  // `CREATE OR REPLACE ...` template literal.
  const NEEDLE_SHAPE = /`CREATE OR REPLACE [^`]*public\.\$\{/

  function extractorFiles(): string[] {
    const roots = ["scripts", "__tests__"]
    const hits: string[] = []
    for (const root of roots) {
      const dir = resolve(process.cwd(), root)
      for (const f of readdirSync(dir)) {
        if (!/\.(mjs|ts)$/.test(f)) continue
        const full = resolve(dir, f)
        let src: string
        try {
          src = readFileSync(full, "utf-8")
        } catch {
          continue
        }
        if (NEEDLE_SHAPE.test(src)) hits.push(`${root}/${f}`)
      }
    }
    return hits
  }

  it("finds the DDL-extractor copies at all (positive control)", () => {
    const files = extractorFiles()
    // Fails loudly if the scan stops matching — a clean result from a broken
    // detector is indistinguishable from a clean repo.
    expect(files.length).toBeGreaterThanOrEqual(3)
    expect(files).toContain("scripts/check-db-pin-staleness.mjs")
    expect(files).toContain("scripts/verify-live-ddl.mjs")
    expect(files).toContain("__tests__/db-invariants-drift-guard.test.ts")
  })

  it("each copy accepts PROCEDURE as well as FUNCTION", () => {
    const offenders: string[] = []
    for (const rel of extractorFiles()) {
      const src = readFileSync(resolve(process.cwd(), rel), "utf-8")
      // Strip line comments first: at least six guards in this repo have fired on
      // the comment documenting the fix rather than the code implementing it.
      const code = src.replace(/^\s*(\/\/|--).*$/gm, "")
      if (!/\bPROCEDURE\b/.test(code)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })
})

