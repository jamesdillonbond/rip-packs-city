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
// That is why this walks only files that CONTAIN a landing expression.
//
// ── IT WAS A RATCHET; AT 2026-09-02 IT REACHED ZERO AND BECAME A BAN ────────
// 61 → 51 → 47 → 28 → **0**, in one night, across `sales-indexer`,
// `allday-sales-indexer`, the five `*-sales-history-backfill` walkers, ten
// forward indexers, `candy-sales-indexer` and two admin routes. A ratchet was
// the right instrument while the population was large and partly benign; at
// zero the honest claim strengthens from "this must not GROW" to "there are
// none", so the baseline is 0 and stays 0.
//
// ⚠ **A ratchet reaching zero BREAKS ITS OWN NOT-VACUOUS CHECK, and this file
// is the worked example.** Its floor asserted `>= 20` real occurrences still
// matched in the tree — a positive control on the DETECTOR that was actually
// keyed on the DEFECT. The moment the last one was fixed the guard went red
// **for succeeding**. That is the "a guard must be satisfiable at a population
// of zero" rule failing in production, on a file whose own header cites it.
// The fix is the shape the cursor-write ban already uses: control the detector
// against SYNTHETIC source, never against the tree's remaining defects.
//
// ⚠ The count is an upper bound on a CLASS, not a defect tally. Do not quote it
// as "N bugs" — and now that it is 0, do not quote it as "no bugs" either: it
// says this expression no longer appears unbound in these files.
//
// ── WHY NOT AN ALLOWLIST ───────────────────────────────────────────────────
// A per-file allowlist is the shape this repo keeps calling theatre: it has to
// be re-read by every future auditor, and three guards have already died on a
// rename. A COUNT is rename-proof.

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
 * **61 → 51 → 47 → 28 → 0.** ⛔ THIS NUMBER GOES DOWN OR STAYS, and it is
 * already at the floor: any rise re-opens the class.
 */
const BASELINE = 0

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

  it("is not vacuous: the DETECTOR still detects", () => {
    // ⚠ This used to assert `>= 20` occurrences still matched IN THE TREE. That
    // is a control keyed on the DEFECT, so it went red the moment the last one
    // was fixed — the guard punishing its own success, which is precisely what
    // this repo's rules forbid. Controlled against SYNTHETIC source instead, it
    // is satisfiable at a population of zero and still catches the two ways this
    // check can silently stop working: stripComments blanking real source, and
    // the regex ceasing to match the shape.
    expect(discardingReads(`const { data } = await supabaseAdmin.from("x")`)).toBe(1)
    expect(discardingReads(`const { data } = await (supabaseAdmin as any).from("x")`)).toBe(1)
    expect(discardingReads(`const { data: rows } = await supabaseAdmin.from("x")`)).toBe(1)
    expect(discardingReads(`const { count: n } = await supabaseAdmin.from("x")`)).toBe(1)
    // Bound reads must NOT count. ⚠ The third of these is the real bug this
    // detector once had: `[^}]*` swallowed the error binding, so a CORRECTLY
    // bound read was reported as a violation and the population read 100+.
    expect(discardingReads(`const { data, error } = await supabaseAdmin.from("x")`)).toBe(0)
    expect(discardingReads(`const { error } = await supabaseAdmin.from("x")`)).toBe(0)
    expect(
      discardingReads(`const { data: cursorRow, error: cursorErr } = await supabaseAdmin.from("x")`),
    ).toBe(0)
    // And the stripper must still be reachable and still blank comments.
    expect(discardingReads(stripComments(`// const { data } = await supabaseAdmin.from("x")`))).toBe(0)
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
  // ⚠ REDUNDANT AGAINST THE BAN, AND KEPT ANYWAY FOR ONE REASON: each row also
  // asserts `family` still CONTAINS the route. The ban alone cannot tell "this
  // route is clean" from "this route is no longer discovered" — a rename, a move
  // under a different folder, or a landing expression being edited out all read
  // as success. These are population detectors wearing a per-route name.
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
