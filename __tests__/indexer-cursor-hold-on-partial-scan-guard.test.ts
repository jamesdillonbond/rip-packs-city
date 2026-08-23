import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

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

/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy stripped BLOCK comments before LINE comments, so an ordinary
 * line comment mentioning a glob path opened a block comment running to the next
 * close-comment anywhere in the file, blanking real source this guard then
 * reported as clean (103,590 chars across 49 product files). The shared version
 * blanks rather than deletes, so offsets and line numbers survive.
 * Do not re-inline a local copy.
 */

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

    // ⚠ KNOWN OFFENDERS — A RATCHET, NOT AN ALLOWLIST. Asserted by EXACT
    // EQUALITY below, so it can only ever SHRINK: fixing one reddens the guard
    // until it is delisted, and a NEW route that swallows cannot join it.
    //
    // ✅ EMPTY SINCE 2026-08-21. It held seven routes for a few hours — the two
    // Pinnacle indexers and the five sales-history backfills — because their fix
    // was genuinely not the one-line throw the other ten took:
    //
    //   pinnacle-listings-indexer had no hold at all (chunk catch neither broke
    //     nor recorded; cursor set to targetHeight unconditionally after the
    //     loop). It now tracks `firstFailedChunkStart` and caps, like its seven
    //     siblings.
    //   pinnacle-sales-indexer wrote the cursor PER CHUNK from a catch that does
    //     not break, so a later chunk leapfrogged a failed one even on a THROWN
    //     error. The per-chunk write is now gated on nothing having failed yet.
    //   the 5 *-sales-history-backfill crons walk history BACKWARD and have a
    //     LEGITIMATE non-throwing non-2xx — a 404 whose body says "is less than",
    //     the node's block floor — so a blanket throw would have broken their
    //     stop condition. They now throw on every OTHER non-2xx and return the
    //     below-floor sentinel only for that one.
    //
    // ⚠ Which is exactly why the swallow test below cannot be "does it return an
    // empty result": the below-floor return IS an empty result, and it is
    // correct. The discriminator is whether the empty result carries a signal
    // the caller acts on. See `swallowsEmpty`.
    const KNOWN_SWALLOWERS: string[] = []

    // Routes named so a rename cannot silently drop one out of the population
    // now that KNOWN_SWALLOWERS is empty and can no longer carry that duty.
    const MUST_BE_DISCOVERED = [
      "app/api/cron/allday-sales-history-backfill/route.ts",
      "app/api/cron/golazos-sales-history-backfill/route.ts",
      "app/api/cron/pinnacle-sales-history-backfill/route.ts",
      "app/api/cron/topshot-flowty-sales-history-backfill/route.ts",
      "app/api/cron/ufc-sales-history-backfill/route.ts",
      "app/api/pinnacle-listings-indexer/route.ts",
      "app/api/pinnacle-sales-indexer/route.ts",
      "app/api/allday-listings-indexer/route.ts",
      "app/api/topshot-offers-indexer/route.ts",
    ]

    /**
     * Does this `if (!res.ok)` handler swallow a failed fetch into an empty
     * result?
     *
     * ⚠ A BARE "returns something empty" TEST IS WRONG HERE, and getting that
     * wrong would have punished the correct fix. The five backfills legitimately
     * return `{ blocks: [], belowFloor: true }` when the access node reports the
     * range is below its block floor — an empty result that is a real answer,
     * not a lost read, and the caller stops the backward walk on it.
     *
     * So the property is: an empty-blocks return is honest ONLY when it carries
     * that sentinel. `{ blocks: [], belowFloor }` — the shorthand that could be
     * false — and a bare `return []` are both the swallow.
     */
    function swallowsEmpty(handler: string): boolean {
      if (/return\s*\[\s*\]/.test(handler)) return true
      const emptyReturns = handler.match(/return\s*\{[^}]*blocks\s*:\s*\[\s*\][^}]*\}/g) ?? []
      return emptyReturns.some((r) => !/belowFloor\s*:\s*true/.test(r))
    }

    /** The `if (!res.ok)` handler inside the named fetcher, comments stripped. */
    function okHandler(route: string, fnName = "fetchEventRange"): string | null {
      const src = stripComments(readFileSync(route, "utf8"))
      const at = src.indexOf(`async function ${fnName}`)
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
      expect(fetchers.length, "the event-range fetcher family is exactly 18").toBe(18)
      // sales-indexer is absent by construction rather than by exemption: it
      // reaches Flow through fcl, which THROWS, so it never had the swallow.
      expect(fetchers).not.toContain("app/api/sales-indexer/route.ts")
      for (const k of MUST_BE_DISCOVERED) {
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
          swallowsEmpty(handler ?? ""),
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

    it("swallowsEmpty discriminates the below-floor sentinel from a lost read", () => {
      // ⚠ GUARDS THE GUARD, and this one is load-bearing rather than ceremonial:
      // the previous regex flagged ANY empty-blocks return, so it would have
      // reported the five backfills as still broken AFTER they were correctly
      // fixed — punishing the fix and pushing the next person to weaken the
      // check. A discriminator that cannot be shown to discriminate is a coin.
      const swallows = [
        "{ return [] }",
        "{ return { blocks: [], belowFloor } }",
        "{ return { blocks: [], belowFloor: false } }",
        // Mixed: throws on one branch, swallows on another. Presence-of-throw
        // alone would call this clean.
        "{ if (a) throw new Error('x')\n return { blocks: [], belowFloor: false } }",
      ]
      for (const h of swallows) {
        expect(swallowsEmpty(h), `should be flagged: ${h}`).toBe(true)
      }
      const honest = [
        "{ throw new Error('HTTP 500') }",
        "{ if (res.status === 404) { return { blocks: [], belowFloor: true } }\n throw new Error('x') }",
        // A non-empty return is not this check's business.
        "{ return { blocks: json, belowFloor: false } }",
      ]
      for (const h of honest) {
        expect(swallowsEmpty(h), `should NOT be flagged: ${h}`).toBe(false)
      }
    })

    // ⚠ THE POPULATION WAS NEVER DERIVED FROM THE RIGHT THING — third correction
    // in one pass, and the one that matters most.
    //
    //   v1  grep `firstFailedChunkStart`               →  8 files (the cursor HOLD)
    //   v2  grep `async function fetchEventRange`      → 17 files (the FETCHER'S NAME)
    //   v3  grep `v1/events`                           → 22 files (the URL)
    //
    // Each earlier derivation is a PROXY for the property, and each proxy leaked:
    // v1 missed every route with no hold; v2 missed every route whose fetcher is
    // called something else. Measured 2026-08-21, v2's blind spot was not
    // hypothetical — it hid TWO live instances of the same permanent-loss bug:
    //
    //   lib/pinnacle/flow-events.ts             fetchCompletedPinnacleSales
    //   app/api/admin/backfill-offer-fill-sales fetchCompletedRange
    //
    // The URL cannot vary — every one of these reads Flow's `/v1/events`. So the
    // population is derived from it, and anything not in the fetchEventRange
    // family has to be ACCOUNTED FOR by name below. Suppression is the curated
    // list; the population is not.
    const urlWalkers = execSync(
      "grep -rl 'v1/events' app lib --include='*.ts' || true",
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean)
      .sort()

    // Reads an event range but persists NO block cursor, so it cannot leapfrog
    // one. ⚠ That claim is ASSERTED below, not asserted-by-comment: the moment
    // one of these gains a cursor, its exemption dies.
    const NO_BLOCK_CURSOR = [
      "app/api/cron/allday-resolve-unmapped-tail/route.ts",
      "app/api/cron/allday-resolve-unmapped/route.ts",
      "lib/chains/flow/allday-edition-onchain.ts",
    ]

    // Has a cursor and IS this class, but its fetcher has another name. Each is
    // held by the entry beside it rather than by the fetchEventRange arm.
    const OTHER_FETCHERS: Record<string, string> = {
      "app/api/admin/backfill-offer-fill-sales/route.ts": "fetchCompletedRange",
      "lib/pinnacle/flow-events.ts": "fetchCompletedPinnacleSales",
    }

    it("every file that reads a Flow event range is accounted for", () => {
      const unaccounted = urlWalkers.filter(
        (f) => !fetchers.includes(f) && !NO_BLOCK_CURSOR.includes(f) && !(f in OTHER_FETCHERS),
      )
      expect(
        unaccounted,
        "a new file reads Flow /v1/events and is in none of the three buckets. " +
          "If it walks blocks behind a cursor, its fetcher must THROW on a non-2xx " +
          "and its caller must hold the cursor — see the 2026-08-21 filing. If it " +
          "keeps no cursor, add it to NO_BLOCK_CURSOR:\n" + unaccounted.join("\n"),
      ).toEqual([])
      // Not vacuous: the sweep still finds the family it was built for.
      expect(urlWalkers.length).toBeGreaterThanOrEqual(22)
    })

    it("the no-cursor exemptions still keep no cursor", () => {
      // ⚠ An exemption justified by a PROPERTY has to re-check the property, or
      // it decays into the per-file allowlist this repo keeps calling theatre.
      const gainedACursor = NO_BLOCK_CURSOR.filter((f) =>
        /event_cursor|backfill_state|last_processed_block/.test(stripComments(readFileSync(f, "utf8"))),
      )
      expect(
        gainedACursor,
        "these were exempt only because they persist no block cursor, and now " +
          "they do. They are in scope for the hold rules:\n" + gainedACursor.join("\n"),
      ).toEqual([])
    })

    it.each(Object.entries(OTHER_FETCHERS))(
      "%s: %s throws on a non-2xx too",
      (route, fnName) => {
        const handler = okHandler(route, fnName)
        expect(handler, `${route}: ${fnName} must check res.ok at all`).not.toBeNull()
        expect(
          swallowsEmpty(handler ?? ""),
          `${route} swallows a non-2xx event fetch into an empty result under a ` +
            `different fetcher name. Same URL, same cursor, same permanent loss.`,
        ).toBe(false)
        expect(/\bthrow\b/.test(handler ?? ""), `${route}: ${fnName} must THROW`).toBe(true)
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
        return h != null && swallowsEmpty(h)
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

// ════════════════════════════════════════════════════════════════════════════
// ⚠ THE FOURTH PROXY, AND THIS ONE IS A DIRECTORY.
//
// Every arm above greps `app/api` or `app lib`. `workers/` and
// `supabase/functions/` are outside ALL of them, and both contain code that
// reads a range of Flow events and persists a cursor — the exact defect this
// file exists for. The population moved 8 → 17 → 19 as each derivation was
// corrected, and every one of those was a derivation over the SOURCE TEXT. The
// scope of the search was never questioned, so a whole class of walker sat
// outside the guard by construction, the same shape CLAUDE.md records for the
// anon driver-message guard (`isPublicPath`) and `check_secdef_anon_exec_drift`
// (`prosecdef = true`).
//
// ⚠ WHAT THIS ARM DOES AND DOES NOT DO — READ BEFORE TRUSTING IT.
//
// It is a REVIEW TRIGGER on the POPULATION, not an assertion about the
// property. It fails when the set of event-range readers in these two
// directories CHANGES, so a new one cannot land unnoticed; it does NOT prove
// the new one holds its cursor. That is deliberate, and measured — I built the
// property check first and it was not trustworthy in EITHER form:
//
//   • FILE-scoped (every `!res.ok` in the file) — 12 false positives on the
//     clean tree, all legitimate: `fetchTxBuyers` and the worker's
//     `txPayerCache` return null on a non-2xx because losing a buyer address
//     degrades a FIELD, while losing an event range moves the CURSOR. Same
//     expression, opposite correctness. Suppressing them needs a curated list,
//     which drifts.
//   • FUNCTION-scoped (only `!res.ok` inside the fetching function) — SILENTLY
//     VACUOUS on the edge functions, which is worse. In
//     `ingest-allday-pack-opens` the URL is built in a small inner helper and
//     the `!r.ok` check lives in the outer `scanOpens`, so the enclosing-function
//     walk found a body with ZERO ok-checks and reported the file clean. It
//     produced "0 violations" on the clean tree AND on a mutant that deleted the
//     error channel outright. A guard that passes both ways is not a guard.
//
// So the honest instrument is the one whose claim it can actually keep. When
// this reddens, open the new file and check the property by hand.
//
// ⚠ MEASURED 2026-08-21: all ten currently hold. Two correct patterns, and the
// second is why a blanket "must throw" rule would have been wrong here:
//   throw on a non-2xx — the 3 egress proxies, pack-events-ingest,
//     hybrid-custody-events, ingest-pinnacle-mints, pinnacle-owner-discovery{,-forward}
//   carry an error CHANNEL and hold on it — ingest-allday-pack-opens and
//     ingest-topshot-pack-opens-history return `{ …, err }` and the caller does
//     `const after = err || rerr ? start - 1 : end` ("don't advance past a
//     failed window"). These are the best implementations of this property in
//     the repo; a rule demanding a `throw` would have reddened them.
describe("event-range walkers outside app/ and lib/ are enumerated, not invisible", () => {
  const OUT_OF_SCOPE_WALKERS = [
    "supabase/functions/hybrid-custody-events/index.ts",
    "supabase/functions/ingest-allday-pack-opens/index.ts",
    "supabase/functions/ingest-pinnacle-mints/index.ts",
    "supabase/functions/ingest-topshot-pack-opens-history/index.ts",
    "supabase/functions/pinnacle-owner-discovery-forward/index.ts",
    "supabase/functions/pinnacle-owner-discovery/index.ts",
    "workers/hybrid-custody-proxy/index.ts",
    "workers/pack-events-ingest/index.ts",
    "workers/pinnacle-events-proxy/index.ts",
    "workers/spork-proxy/index.ts",
  ]

  const found = execSync(
    "grep -rlE 'v1/events|getEventsAtBlockHeightRange' workers supabase/functions --include='*.ts' || true",
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean)
    .sort()

  it("the set of out-of-scope event-range walkers is unchanged", () => {
    expect(
      found,
      "the event-range walkers outside app/ and lib/ changed. No property guard " +
        "covers these files, so this list is the only thing standing between a " +
        "new one and the swallow that reached 19 instances. If you ADDED one: " +
        "check by hand that a failed range cannot advance its cursor (throw, or " +
        "return an error channel the caller holds on), then add it here. If you " +
        "REMOVED one: delete it from the list.",
    ).toEqual(OUT_OF_SCOPE_WALKERS)
  })

  it("is not vacuous: the directories are actually being read", () => {
    // ⚠ A guard that silently searched nothing would pass the assertion above
    // by comparing [] to []. This repo has shipped exactly that
    // (`check-tree-corruption.mjs`, `0 file(s) checked`, exit 0), so assert the
    // count it INSPECTED, not just the comparison.
    expect(found.length, "expected 10 event-range readers outside app/ and lib/").toBe(10)
    expect(found.some((f) => f.startsWith("workers/"))).toBe(true)
    expect(found.some((f) => f.startsWith("supabase/functions/"))).toBe(true)
  })
})
