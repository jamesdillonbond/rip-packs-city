import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { filesMatching } from "./helpers/source-files"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// A read whose MISS IS RECORDED must bind its `error`.
//
// ── THE CLASS (2026-09-02, the tenth shape in key-files-and-honesty.md) ─────
// supabase-js RETURNS errors rather than throwing, so
//
//     const { data } = await (supabaseAdmin as any).from("x").select(…).in(…)
//     for (const row of data ?? []) map.set(row.k, row.v)
//
// turns a FAILED READ into "there is no row for any of these ids". In an
// enrichment loop that costs one un-enriched row and the next tick fixes it.
// In the routes this guard walks, `not found` is RECORDED — and four distinct
// landing places were found in one sweep, each of them destructive:
//
//   retry_count + 1        ten bumps RETIRE the row permanently; at */15 a
//                          sustained read failure clears a queue in 2.5 hours
//   the cursor advances    zero rows written, ok:true, and nothing revisits a
//                          block below the cursor — the rows are simply GONE
//   a queue is flooded     the retry drainer then spends real Cadence calls and
//                          a finite retry budget on rows that were fine
//   edition_id: null       written once with `ignoreDuplicates: true`, so no
//                          later tick ever corrects it
//
// 👉 **The discriminator is not the expression, it is WHERE `not found` LANDS.**
// That is why this walks only files that CONTAIN a landing expression, and why
// it is a RATCHET rather than a ban: most of the remaining occurrences are
// probably harmless even in these files, and the honest claim is
// "this class must not GROW here", not "each of these is a defect".
//
// ── WHY A RATCHET AND NOT AN ALLOWLIST ─────────────────────────────────────
// A per-file allowlist is the shape this repo keeps calling theatre: it has to
// be re-read by every future auditor, and three guards have already died on a
// rename. A COUNT is rename-proof. Drive it DOWN; never up.
//
// ⚠ The count is an upper bound on a CLASS, not a defect tally. Do not quote it
// as "N bugs".

/** Where a missed row gets RECORDED rather than retried. */
const LANDING = /retry_count|RETRY_COUNT_CAP|UNRESOLVABLE|resolved_at|last_processed_block/

/** `const { … } = await …supabaseAdmin…` — the braces captured so `error` can be looked for. */
const DISCARD = /const\s*\{([^}]*)\}\s*=\s*await\s*\(?\s*supabaseAdmin/g

function discardingReads(src: string): number {
  let n = 0
  let m: RegExpExecArray | null
  DISCARD.lastIndex = 0
  while ((m = DISCARD.exec(src))) if (!/\berror\b/.test(m[1])) n++
  return n
}

const family = filesMatching("app/api", (n) => n === "route.ts", LANDING)

/**
 * Measured 2026-09-02 over 35 consequential routes, comments stripped.
 * **61 → 51 → 47 → 28**: `sales-indexer`'s ten map-building reads, then
 * `allday-sales-indexer`'s four, then the five `*-sales-history-backfill`
 * routes' nineteen — five cursor reads whose failure RESET the backward walk,
 * and fourteen chunked id lookups whose failure read as "unmapped". ⛔ THIS
 * NUMBER GOES DOWN OR STAYS. Raising it re-opens the class.
 */
const BASELINE = 28

describe("a read in a consequential route binds its error", () => {
  // ⚠ filesMatching returns [] for a root that does not exist, and a guard that
  // inspects nothing passes. The floors below are the only thing that catches
  // that — and they also catch stripComments blanking real source, which this
  // repo has recorded going wrong three times.
  it("is not vacuous: it discovered the consequential family", () => {
    expect(family.length).toBeGreaterThanOrEqual(30)
    for (const r of [
      "app/api/sales-indexer/route.ts",
      "app/api/allday-sales-indexer/route.ts",
      "app/api/topshot-offers-indexer/route.ts",
      "app/api/allday-listings-retry/route.ts",
    ]) {
      expect(family, `${r} must still be discovered`).toContain(r)
    }
  })

  it("is not vacuous: the pattern still matches real source", () => {
    // A positive control on the DETECTOR itself. If stripComments blanks the
    // tree or the regex stops matching, this floor fires instead of the ratchet
    // silently reading zero and passing.
    const total = family.reduce(
      (n, f) => n + discardingReads(stripComments(readFileSync(f, "utf8"))),
      0,
    )
    expect(total).toBeGreaterThanOrEqual(20)
  })

  it(`does not exceed the ${BASELINE}-occurrence baseline`, () => {
    const per = family
      .map((f) => [f, discardingReads(stripComments(readFileSync(f, "utf8")))] as const)
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
    const total = per.reduce((n, [, c]) => n + c, 0)
    expect(
      total,
      `error-discarding reads in consequential routes rose to ${total} (baseline ${BASELINE}).\n` +
        per.map(([f, n]) => `  ${n}  ${f}`).join("\n") +
        `\nBind the error and throw, or move the read out of a route that records its misses.`,
    ).toBeLessThanOrEqual(BASELINE)
  })

  // ⛔ THE FIXES ARE PINNED. These five were swept on 2026-09-02 and each one's
  // failure mode is written up in key-files-and-honesty.md. A revert must red a
  // test rather than quietly restore the defect.
  it.each([
    "app/api/topshot-offers-indexer/route.ts",
    "app/api/cron/pinnacle-trades-indexer/route.ts",
    "app/api/allday-listings-indexer/route.ts",
    "app/api/allday-listings-retry/route.ts",
    "app/api/pinnacle-listings-retry/route.ts",
    // The largest single instance: ten reads in the route that writes Top Shot
    // sales, whose miss dropped the sale AND advanced the cursor.
    "app/api/sales-indexer/route.ts",
    // Its AllDay sibling: the serial lookup there is the last source before the
    // row is written, and a NULL serial does not self-heal.
    "app/api/allday-sales-indexer/route.ts",
    // The five backward history backfills. Their cursor read is the worst case
    // in the family: a failure left `ceiling` at CEILING_INIT and the tick then
    // wrote that TOP block back over the real cursor, discarding the whole
    // backward walk in one run at ok:true, with nothing that re-walks above a
    // cursor to recover it.
    "app/api/cron/allday-sales-history-backfill/route.ts",
    "app/api/cron/golazos-sales-history-backfill/route.ts",
    "app/api/cron/topshot-flowty-sales-history-backfill/route.ts",
    "app/api/cron/ufc-sales-history-backfill/route.ts",
    "app/api/cron/pinnacle-sales-history-backfill/route.ts",
  ])("%s binds the error on every supabaseAdmin read", (route) => {
    expect(family, `${route} must still be discovered`).toContain(route)
    expect(discardingReads(stripComments(readFileSync(route, "utf8")))).toBe(0)
  })
})
