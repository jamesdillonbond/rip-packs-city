import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"

// The block-scan cursor must never leapfrog a chunk that FAILED to scan.
//
// ── WHY THIS IS THE SAME CLASS AS THE 23505 BUG ────────────────────────────
// These indexers walk Flow in chunks and persist a cursor. If one chunk's fetch
// fails and the cursor still advances to `targetHeight`, every sale in the
// failed range is skipped FOREVER — the next tick starts after it. Nothing
// errors, nothing retries, and the rows simply never exist. That is exactly the
// permanent-loss shape CLAUDE.md records for the batch-insert 23505 defect,
// which reached FIVE indexers by copy-paste before anyone noticed.
//
// ── WHY A DIRECTORY-DRIVEN GUARD ───────────────────────────────────────────
// Measured 2026-08-15: **8 routes implement a cursor hold, and only 2 test files
// reference it** — neither of them covering `allday-sales-indexer` or
// `sales-indexer`, the two largest by uncovered branches (134 and 118). This
// family grows by copy-paste, so a hand-kept list would be one new collection
// behind. Discovering the members from the source means a ninth indexer is
// covered the day it lands.
//
// ── TWO VALID STRATEGIES, AND THE GUARD MUST ACCEPT BOTH ───────────────────
// Seven routes accumulate chunk failures and CAP the final cursor at
// `firstFailedChunkStart - 1`. `ufc-sales-indexer` instead advances the cursor
// per-chunk INSIDE the loop and `break`s on the first failure, so it has no
// cap expression at all — and it is not wrong, it is the other correct answer.
// Requiring the cap alone would have red-flagged a working route, and
// allowlisting it would be the per-file allowlist this repo keeps calling
// theatre. So the assertion is the DISJUNCTION: cap the cursor, or stop the
// loop. What is forbidden is neither.
//
// ⚠ This is a SOURCE guard on purpose. Driving these bodies needs the full Flow
// REST fetch surface stubbed per route (see api-golazos-ufc-sales-indexer-deep
// for what that costs), and CLAUDE.md's standing decision is not to refactor
// production ingest with a permanent-data-loss failure mode for the sake of
// branch percentage. A source property is what is available for all 8 at once;
// it complements the execution tests rather than replacing them.

function stripComments(s: string): string {
  // Required, not tidiness: several of these routes explain the hold in a
  // comment that quotes the very expression being asserted ("Stop before a
  // later chunk leapfrogs the cursor past this failed one."). This repo has
  // tripped that trap five times.
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
}

/** Every route that tracks a first-failed chunk, discovered from source. */
const routes = execSync(
  "grep -rl 'firstFailedChunkStart' app/api --include=route.ts || true",
  { encoding: "utf8" },
)
  .split("\n")
  .filter(Boolean)
  .sort()

describe("block-scan indexers hold the cursor at a failed chunk", () => {
  it("is not vacuous: it discovered the indexer family", () => {
    expect(routes.length).toBeGreaterThanOrEqual(8)
    // The two with the most uncovered branches, and the two the existing
    // execution tests already cover — named so a rename cannot silently drop
    // any of them out of the family.
    for (const r of [
      "app/api/allday-sales-indexer/route.ts",
      "app/api/sales-indexer/route.ts",
      "app/api/ufc-sales-indexer/route.ts",
      "app/api/golazos-sales-indexer/route.ts",
    ]) {
      expect(routes, `${r} must still be discovered`).toContain(r)
    }
  })

  it.each(routes)("%s records the partial scan", (route) => {
    const src = stripComments(readFileSync(route, "utf8"))
    // Without this the run reports a clean full scan of a range it did not
    // finish, so the gap is invisible in pipeline_runs as well as in the data.
    expect(src, `${route} must set partial_scan when a chunk failed`).toMatch(
      /partial_scan['"]?\s*[:=]\s*true/,
    )
    expect(src, `${route} must record WHICH chunk failed`).toMatch(
      /first_failed_chunk['"]?\s*[:=]/,
    )
  })

  it.each(routes)("%s either caps the cursor or stops the loop", (route) => {
    const src = stripComments(readFileSync(route, "utf8"))
    // Strategy A — accumulate and cap the final cursor below the failed chunk.
    const capsCursor = /firstFailedChunkStart\s*-\s*1/.test(src)
    // Strategy B — advance per chunk and break out on the first failure, so no
    // later chunk can write a higher cursor.
    const breaksOnFailure = /firstFailedChunkStart\s*=\s*\w+\s*\n\s*break/.test(src)
    expect(
      capsCursor || breaksOnFailure,
      `${route} tracks a failed chunk but neither caps the cursor at ` +
        `firstFailedChunkStart - 1 nor breaks out of the scan loop. Without one ` +
        `of the two, a later chunk advances the cursor past the failed range and ` +
        `those blocks are never scanned again.`,
    ).toBe(true)
  })

  it("the cursor is never written unconditionally from targetHeight in a capping route", () => {
    // The precise regression: replacing the ternary with a bare `targetHeight`
    // leaves partial_scan set — so the run still LOOKS honest in pipeline_runs
    // — while the blocks are skipped. Telemetry and behaviour must not be able
    // to disagree, which is why this is asserted separately from the flag above.
    const offenders: string[] = []
    for (const route of routes) {
      const src = stripComments(readFileSync(route, "utf8"))
      if (!/firstFailedChunkStart\s*-\s*1/.test(src)) continue // strategy B
      const ternary = /firstFailedChunkStart\s*!==\s*null\s*\?\s*firstFailedChunkStart\s*-\s*1\s*:\s*targetHeight/
      if (!ternary.test(src)) offenders.push(route)
    }
    expect(
      offenders,
      "a capping route must derive its final cursor from the ternary, not from " +
        "targetHeight alone:\n" + offenders.join("\n"),
    ).toEqual([])
  })
})
