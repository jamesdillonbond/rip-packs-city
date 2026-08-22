import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// Regression guard for the "cursor advances past a failed fetch → silent
// permanent data loss" class fixed on 2026-07-29.
//
// These four edge functions are DESCENDING/forward Flow-REST cursored walkers
// whose safety model is THROW-and-HOLD: when the Flow REST /v1/events fetch
// returns non-OK, the fetch helper must THROW (not `return []`). A throw is
// caught by the per-chunk try/catch, which `break`s and leaves the cursor at the
// last fully-scanned chunk. `return []` on a non-OK fetch is indistinguishable
// from a genuinely empty window, so the cursor advances past the un-fetched
// range and the events in it (owner snapshots / mints / custody links) are never
// re-scanned. That exact regression shipped once and was invisible in every
// external signal.
//
// The bodies are Deno source (outside vitest/tsc), so this reads them as text
// and asserts the structural invariant. The list is EXPLICIT rather than
// discovered: the pack-opens-history family uses a different, equally-valid
// safety pattern (bounded-advance via scannedFloor), so a blanket "must throw"
// rule would false-trip on it. Add a fn here only if it is a throw-and-hold
// Flow-REST walker.

const THROW_PATTERN_WALKERS = [
  "pinnacle-owner-discovery-forward",
  "pinnacle-owner-discovery",
  "ingest-pinnacle-mints",
  "hybrid-custody-events",
] as const

function readEdgeSource(fn: string): string {
  return readFileSync(
    path.resolve(__dirname, `../supabase/functions/${fn}/index.ts`),
    "utf8",
  )
}

// Strip comments so the negative check can't be fooled by the fixed fns'
// explanatory comment (which literally contains the text "don't return []").
// `[^:]` before `//` preserves `https://` URLs in string literals.
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * also blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

const ANTIPATTERN = /![\w.]+\.ok\)\s*\{?\s*return\s*\[\]/

describe("the anti-pattern regex actually catches the bug (guard is not a no-op)", () => {
  it("matches the reverted shape and clears the fixed shape", () => {
    // The exact 2026-07-29 bug: return [] on a non-OK fetch.
    expect(ANTIPATTERN.test("if (!res.ok) return []")).toBe(true)
    expect(ANTIPATTERN.test("if (!res.ok) { return [] }")).toBe(true)
    // The fix: throw instead. Must NOT match.
    expect(ANTIPATTERN.test("if (!res.ok) { throw new Error('boom') }")).toBe(false)
  })
})

describe("edge cursored walkers hold the cursor on a failed events fetch", () => {
  for (const fn of THROW_PATTERN_WALKERS) {
    describe(fn, () => {
      const src = readEdgeSource(fn)

      it("throws on a non-OK events fetch (holds the cursor) rather than returning []", () => {
        // Positive: a non-OK guard is followed (within a small window) by a throw.
        expect(
          /![\w.]+\.ok\)[\s\S]{0,200}throw new Error/.test(src),
          `${fn}: expected a non-OK fetch guard to throw`,
        ).toBe(true)
      })

      it("never returns [] from a non-OK fetch branch (the exact reverted bug)", () => {
        // The anti-pattern: a non-OK guard whose BODY is `return []` — advancing
        // past a failed window as if it were empty. Comments are stripped first so
        // the fixed fns' "don't return []" comment can't false-trip it; what's
        // left must show an ACTUAL return-[] as the branch body, which the throw
        // pattern never has (a `throw` sits where the return would be).
        const code = stripComments(src)
        expect(
          ANTIPATTERN.test(code),
          `${fn}: a non-OK fetch branch returns [] — reintroduces the silent-data-loss bug`,
        ).toBe(false)
      })
    })
  }
})
