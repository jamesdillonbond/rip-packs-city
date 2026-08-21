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

  // ⚠ THE ARM ADDED 2026-08-21, AFTER THE GUARD ABOVE PASSED THROUGH THE DEFECT.
  //
  // Everything above asserts what the chunk loop does once it KNOWS a chunk
  // failed. It says nothing about how the loop finds out — and that was the
  // hole. `fetchEventRange` swallowed a non-2xx into `return []`, so an HTTP 500
  // was delivered to the loop as a chunk that read fine and contained nothing.
  // `firstFailedChunkStart` stayed null, the cap ternary chose `targetHeight`,
  // `partial_scan` stayed false, and every assertion in this file passed while
  // seven routes silently skipped whatever blocks the access node had failed on.
  //
  // The durable lesson, and the reason this arm is worth more than the fix:
  // a guard's blast radius is fixed by its own derivation. This one derived its
  // property from the CAP EXPRESSION, so the question "does the failure ever
  // reach the code that caps?" was outside it by construction — the exact shape
  // CLAUDE.md records for the anon driver-message guard and for
  // check_secdef_anon_exec_drift. Asserting the consequence is not asserting the
  // cause.
  //
  // Scoped to `fetchEventRange` deliberately, NOT to every `!res.ok` in the
  // file: `fetchTxBuyers` legitimately returns [] on a non-2xx, because losing a
  // buyer address degrades one FIELD, while losing an event range moves the
  // CURSOR. Same expression, opposite correctness — so the assertion has to be
  // made at the granularity of the property, not of the file.
  describe("the event-range fetch reports a failure instead of swallowing it", () => {
    // ⚠ DERIVED FROM THE PROPERTY BEING ASSERTED, NOT FROM ITS NEIGHBOUR.
    //
    // The first version of this arm reused `routes` above, which is discovered
    // by grepping for `firstFailedChunkStart`. That found 8 files and read as
    // thorough. The real population of routes that fetch an event range is 17 —
    // the three offers indexers, the two Pinnacle indexers and the five
    // sales-history backfills all have the same fetcher and none of them
    // contains that symbol, because none of them implements a per-chunk hold.
    // They were outside the guard BY CONSTRUCTION, which is why the swallow
    // survived in them after the first sweep "fixed everything".
    //
    // A directory-driven grep for the fetcher itself is the derivation that
    // matches the claim, so a new indexer joins the population the day it lands.
    const fetchers = execSync(
      "grep -rl 'async function fetchEventRange' app/api --include=route.ts || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort()

    // ⚠ KNOWN OFFENDERS — A RATCHET, NOT AN ALLOWLIST. This set is asserted by
    // EXACT EQUALITY below, so it can only ever SHRINK: fixing one of these
    // reddens the guard until it is removed from the list, and a NEW route that
    // swallows cannot join it. That is the difference between a ratchet and the
    // per-file allowlist this repo keeps calling theatre.
    //
    // Why these seven are not simply fixed alongside the ten that were: their
    // fix is NOT the one-line throw. Measured 2026-08-21:
    //
    //   pinnacle-{listings,sales}-indexer — swallow AND have no cursor hold at
    //     all. pinnacle-listings advances to targetHeight unconditionally after
    //     the loop; pinnacle-sales advances PER CHUNK inside a catch that does
    //     not break, so a later chunk leapfrogs a failed one even on a THROWN
    //     error. Throwing alone changes nothing there — they need the full
    //     partial-scan pattern, on a live Pinnacle ingest path.
    //
    //   *-sales-history-backfill (5) — swallow non-2xx AND thrown errors into
    //     `{blocks: [], belowFloor}`, then advance the backward cursor with
    //     `const newLow = belowFloor ? start : start` (both branches identical),
    //     unconditionally. A failed sub-range is skipped permanently, and these
    //     walk HISTORY, so nothing ever comes back for it. They also have a
    //     legitimate non-throwing case (a 404 "is less than" below the node's
    //     block floor), so the fix has to distinguish it rather than throw on
    //     every non-2xx.
    //
    // Filed with measurements in
    // docs/overnight/inbox/2026-08-21T1420Z-an-http-error-defeats-the-cursor-hold-in-7-of-8-indexers.md
    const KNOWN_SWALLOWERS = [
      "app/api/cron/allday-sales-history-backfill/route.ts",
      "app/api/cron/golazos-sales-history-backfill/route.ts",
      "app/api/cron/pinnacle-sales-history-backfill/route.ts",
      "app/api/cron/topshot-flowty-sales-history-backfill/route.ts",
      "app/api/cron/ufc-sales-history-backfill/route.ts",
      "app/api/pinnacle-listings-indexer/route.ts",
      "app/api/pinnacle-sales-indexer/route.ts",
    ]

    /** The `if (!res.ok)` handler inside fetchEventRange, comments stripped. */
    function okHandler(route: string): string | null {
      const src = stripComments(readFileSync(route, "utf8"))
      const at = src.indexOf("async function fetchEventRange")
      if (at < 0) return null
      // ⚠ NOT `indexOf("{", at)`. The backfills declare
      // `): Promise<{ blocks: FlowEventBlock[]; belowFloor: boolean }> {`, so the
      // first brace after the name belongs to the RETURN TYPE, and brace-matching
      // from it walks the signature instead of the body — which silently reported
      // those five routes as clean. The body brace is the first one that ends its
      // line; a brace inside a type literal is always followed by more type.
      const open = src.indexOf("{\n", at)
      let depth = 0
      let close = open
      for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++
        else if (src[i] === "}" && --depth === 0) {
          close = i
          break
        }
      }
      const body = src.slice(open, close + 1)
      const okAt = body.indexOf("if (!res.ok)")
      if (okAt < 0) return null
      const rest = body.slice(okAt + "if (!res.ok)".length)
      const brace = rest.indexOf("{")
      const nl = rest.indexOf("\n")
      if (brace > -1 && (nl === -1 || brace < nl)) {
        let d = 0
        for (let i = brace; i < rest.length; i++) {
          if (rest[i] === "{") d++
          else if (rest[i] === "}" && --d === 0) return rest.slice(brace, i + 1)
        }
      }
      return rest.slice(0, nl === -1 ? rest.length : nl)
    }

    it("discovered every route that fetches an event range itself", () => {
      // A no-slack count. `toBeGreaterThanOrEqual` would let a route that lost
      // its fetcher to a rename drop out of the population unnoticed.
      expect(fetchers.length, "the event-range fetcher family is exactly 17").toBe(17)
      // sales-indexer is absent by construction rather than by exemption: it
      // reaches Flow through fcl, which THROWS, so it never had the swallow.
      expect(fetchers).not.toContain("app/api/sales-indexer/route.ts")
      for (const k of KNOWN_SWALLOWERS) {
        expect(fetchers, `${k} must still be discovered`).toContain(k)
      }
    })

    it.each(fetchers.filter((r) => !KNOWN_SWALLOWERS.includes(r)))(
      "%s: fetchEventRange throws on a non-2xx",
      (route) => {
        const handler = okHandler(route)
        expect(handler, `${route} fetchEventRange must check res.ok at all`).not.toBeNull()

        // ⚠ Assert the ABSENCE of the false report, not merely the presence of
        // a throw: a handler that threw on one branch and returned an empty
        // result on another would satisfy a presence-only check while keeping
        // the hole. Mutation-verified against exactly that shape.
        expect(
          /return\s*(\[\s*\]|\{[^}]*blocks\s*:\s*\[\s*\])/.test(handler ?? ""),
          `${route} swallows a non-2xx event fetch into an empty result. The ` +
            `chunk loop only ever sees THROWN errors, so the failed range reads ` +
            `as GENUINELY EMPTY, the cursor advances past blocks nothing ` +
            `scanned, and nothing revisits a block below the cursor — permanent ` +
            `loss behind an ok:true run. Throw instead.`,
        ).toBe(false)
        expect(
          /\bthrow\b/.test(handler ?? ""),
          `${route} fetchEventRange must THROW on a non-2xx so the caller can ` +
            `hold the cursor.`,
        ).toBe(true)
      },
    )

    it("the known-swallower list only ever shrinks", () => {
      // ⚠ EXACT EQUALITY, both directions. A route that gets fixed must be
      // REMOVED from the list (or this reddens), and a route that regresses
      // cannot be quietly added without editing a list whose every entry
      // carries a dated measurement. This is the ratchet; the per-file skip
      // above is only safe because of it.
      const stillSwallowing = fetchers.filter((r) => {
        const h = okHandler(r)
        return h != null && /return\s*(\[\s*\]|\{[^}]*blocks\s*:\s*\[\s*\])/.test(h)
      })
      expect(
        stillSwallowing,
        "the set of event-range fetchers that swallow a non-2xx changed. If you " +
          "FIXED one, delete it from KNOWN_SWALLOWERS. If this grew, a new route " +
          "shipped with a permanent-data-loss bug — see the 2026-08-21 filing.",
      ).toEqual(KNOWN_SWALLOWERS)
    })
  })
})
