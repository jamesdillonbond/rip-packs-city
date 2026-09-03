import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ── THE INVOCATION-HEARTBEAT RATCHET ───────────────────────────────────────
//
// CLAUDE.md states the rule: "Any `after()` route needs an invocation heartbeat
// written BEFORE the work, under a separate `<pipeline>-heartbeat` name, or a
// killed tick is indistinguishable from a cron that never fired."
//
// It is the one rule in that document's honesty family with NO guard. `?? 0`
// divisors, unordered `.range()` pagination, client failure-collapse and
// server-page data access all have a ratchet or a ban; this had a sentence and
// five hand-rolled implementations. Measured 2026-08-20: 71 routes qualify and
// 5 had a heartbeat.
//
// ⚠ WHY THE POPULATION IS DERIVED THIS WAY, AND NOT FROM A PATH CONVENTION.
// The obvious predicate — "routes under `app/api/cron/`" — is a curated list
// wearing a glob, and this repo has paid for that shape repeatedly (the anon
// driver-message guard derived its file set from `isPublicPath`; the SEO guard
// named three helpers). A cron entry can point at ANY path, and several of the
// routes below sit under `/admin/` or a bare `/<name>-indexer/`.
//
// So the predicate is structural and self-maintaining:
//
//   a route that calls `after(` AND writes a terminal `pipeline_runs` row
//
// That is exactly the set where a kill is INVISIBLE, and it says so in its own
// code rather than in a list here. Writing a terminal row means something
// watches this pipeline — `detect_stalled_pipelines`, the cadence watchlist,
// `v_pipeline_failure_rates` — so the row's ABSENCE is the signal, and a
// `maxDuration` kill produces exactly that absence with no error anywhere.
// `try/catch` cannot catch the kill; a `finally` does not run reliably under the
// lambda lifecycle. The marker written BEFORE the work is the only evidence.
//
// ⚠ A RATCHET, NOT A BAN, DELIBERATELY. 66 routes is far too many to convert in
// one pass, and some may not want a marker (a route whose terminal row is
// incidental rather than watched). Lower BUDGET in the same commit that converts
// a route; never raise it. At zero, replace this with a ban.
//
// ── WHICH OF THE 66 TO DO FIRST (measured 2026-08-20, re-derive before acting) ──
//
// Not all 66 are equal, and the discriminator is measurable rather than a matter
// of taste: **is anything watching this pipeline's SILENCE?** Cross-referencing
// the 66 against `pipeline_cadence_watchlist WHERE is_active` gives **32**.
//
// Those 32 are the ones where a `maxDuration` kill is not merely unlogged but
// ACTIVELY MISREAD. `detect_stalled_pipelines()` alerts on the absence of a
// terminal row, so a killed tick and a cron that never fired produce the
// identical alert — and the two need opposite responses (fix the route vs. fix
// the schedule). The heartbeat is what separates them. On the other 34 the
// marker is worth having but nothing is currently drawing a wrong conclusion
// without it.
//
// The 32, by route (their watchlisted pipeline name in parentheses where it
// differs from the path):
//   app/api/sales-indexer                      (topshot-sales-indexer)
//   app/api/allday-sales-indexer               app/api/golazos-sales-indexer
//   app/api/allday-listings-indexer            app/api/allday-listings-retry
//   app/api/allday-pack-listings               app/api/pinnacle-listings-indexer
//   app/api/golazos-listings-indexer           app/api/candy-sales-indexer
//   app/api/topshot-fmv-populate               app/api/topshot-listing-cache
//   app/api/wmc-fmv-populate                   app/api/wallet-backfill
//   app/api/admin/apply-fmv-haircut            app/api/admin/backfill-topshot-buyers
//   app/api/cron/offers-sweep                  app/api/cron/lock-check-batch
//   app/api/cron/panini-ingest                 app/api/cron/pinnacle-sync
//   app/api/cron/pinnacle-events-ingest        app/api/cron/pinnacle-wmc-render-id
//   app/api/cron/snapshot-pack-asks            app/api/cron/run-insider-detectors
//   app/api/cron/ufc-enrichment-drain          app/api/cron/allday-lock-refresh-batch
//   app/api/cron/allday-resolve-unmapped       app/api/cron/backfill-pack-rip-metadata
//   app/api/cron/refresh-pack-grail-metrics-mv app/api/cron/populate-pinnacle-wmc-fmv
//   app/api/cron/resolve-wallet-usernames      (wallet-username-resolver)
//   app/api/cron/backfill-pack-pull-source-rip-id (pack-pull-source-rip-id-backfill)
//   app/api/cron/classify-acquisitions-multicollection
//
// ⚠ This list is a dated SAMPLE and deliberately NOT an assertion — the
// watchlist is live data a test cannot read (`db-tests` runs against a throwaway
// Postgres), and freezing it here would create exactly the curated list the
// predicate above avoids. It is a work queue, not a guard.

const ROOT = path.resolve(__dirname, "..")
const API = path.join(ROOT, "app", "api")

/**
 * ⚠ Strip comments FIRST. At least six guards in this repo have fired on the
 * comment documenting the fix rather than the fix — and here the risk runs both
 * ways: every one of the five converted routes carries a long comment ABOUT the
 * heartbeat, so an un-stripped grep for `writeInvocationHeartbeat` would also
 * match a route that merely mentions it in prose and vouch for a route that
 * never calls it.
 */
/* Shared stripper — the local copy ran the block regex first, so a line comment
 * containing an open-comment swallowed source to the next close anywhere in the file. */

/** Every `route.ts`/`route.tsx` under `app/api`, by walk — never a list. */
function apiRoutes(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) apiRoutes(full, out)
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full)
  }
  return out
}

interface Route {
  rel: string
  usesAfter: boolean
  logsTerminalRun: boolean
  hasHeartbeat: boolean
}

const ROUTES: Route[] = apiRoutes().map((full) => {
  const code = stripComments(readFileSync(full, "utf8"))
  return {
    rel: path.relative(ROOT, full).split(path.sep).join("/"),
    usesAfter: /\bafter\s*\(/.test(code),
    logsTerminalRun: /log_pipeline_run|["']pipeline_runs["']/.test(code),
    // ⚠ The CALL, not the identifier. Matching the bare name also matches the
    // `import { writeInvocationHeartbeat }` line, so a route that imports the
    // helper and never calls it would be vouched for — caught by mutation on
    // 2026-08-20, when deleting fmv-recalc's call left this ratchet green.
    // Assert at the property's granularity, which here means the open paren.
    hasHeartbeat:
      /writeInvocationHeartbeat\s*\(/.test(code) ||
      // ⚠ THE SECOND MARKER CONVENTION, added 2026-08-28. A route that writes a
      // `<x>-dispatch` row AND an `<x>-complete` row has hand-rolled exactly this
      // correlation and is INSTRUMENTED, not missing.
      // `app/api/wallet-backfill-multicollection` predates lib/pipeline/heartbeat.ts
      // and does this; its own comment says "dispatch row with no matching complete
      // row within ~15min = killed lambda — that's the visibility we want", and the
      // pair is live in `pipeline_runs` (2,339 / 1,368 rows on 2026-08-28).
      //
      // ⚠ Counting it as MISSING is not a harmless over-count. The remedy this
      // ratchet prescribes is "add a marker", so the next session to work the list
      // would bolt a SECOND marker onto a route that already has one — duplicate
      // instrumentation on the fleet's highest-volume pipeline. The exemption is
      // therefore load-bearing, not cosmetic.
      //
      // ⚠ Asserted at the PROPERTY's granularity, like the rule above it: BOTH
      // halves must be present. A `-dispatch` alone is not a marker — `alerts-dispatch`
      // is a real pipeline whose name merely ends that way, and matching the suffix
      // alone would silently excuse any route that logs it. Same discriminator as
      // `lib/pipeline/kill-rate.ts` uses on the run rows.
      (/["'`][a-z0-9-]+-dispatch["'`]/.test(code) && /["'`][a-z0-9-]+-complete["'`]/.test(code)),
  }
})

/** The set where a `maxDuration` kill is invisible. */
const QUALIFYING = ROUTES.filter((r) => r.usesAfter && r.logsTerminalRun)
const MISSING = QUALIFYING.filter((r) => !r.hasHeartbeat)

// 2026-08-20 (landing): 71 qualifying routes, 5 with a heartbeat, 66 without.
//   The 5: fmv-recalc, admin/drain-fmv-cold-tail, candy-listings-indexer,
//   ingest/candy-editions, ingest/candy-offers — all five converted to
//   `lib/pipeline/heartbeat.ts` in the same commit that added this file, which
//   is where the "no two of the five agreed" measurement came from.
// 2026-08-20 (same day, second pass): 66 -> 55. Eleven conversions, all from the
//   watchlisted tier, so each one restores an arm that could not fire:
//     seven with no marker at all — golazos/allday/pinnacle listings + sales
//     indexers, allday-listings-retry, cron/snapshot-pack-asks;
//     FOUR that already had a marker under their OWN pipeline name, which is
//     strictly worse than none (see the ban below).
// Lower this in the SAME commit that converts a route. Never raise it.
// ⚠ 2026-08-20, THIRD EDIT OF THIS CONSTANT IN ONE DAY, AND IT COLLIDED.
//   Two sessions ran this workstream concurrently and each lowered the budget by
//   ITS OWN conversions only: a1a5f4f9 took 66 -> 62 (the four maxDuration=800
//   routes, the highest kill risk in the fleet), this pass took 66 -> 55 (eleven
//   from the watchlisted tier). ⚠ BOTH ARE WRONG, and "take mine"/"take theirs"
//   are equally wrong — the value is a COUNT of a shared population, not an
//   opinion. Re-derived from the failing no-slack assertion rather than by
//   arithmetic on the two sides, exactly as this repo's ratchet history requires.
//   Re-derived live: **51**. Not 62, not 55, and note that it is also exactly
//   66 - 4 - 11 — the arithmetic agrees here only because the two sessions
//   happened to touch disjoint routes. Read it off the assertion anyway; a
//   single overlapping route would have made the sum wrong and silently
//   licensed one more un-heartbeated route.
// 2026-08-20 (fourth): 51 -> 50. `sales-indexer` (topshot-sales-indexer, 180-min
//   arm), converted alongside behavioural tests for its partial-scan cursor hold
//   — it was also the worst REACHABLE branch coverage in app/api at 59.3%.
// 2026-08-21 (fifth): 50 -> 49, and ⚠ NOT by converting a route. The population
//   SHRANK: app/api/cron/pinnacle-listings-reconcile was deleted (retired
//   2026-07-17 behind ASK_UNIFY_RETIRED; measured before deleting — no pg_cron
//   job, watchlist row is_active=false, and ZERO rows in pipeline_runs_daily,
//   which is retained indefinitely, so it had not run at all). It was one of the
//   un-heartbeated routes, so the budget has to follow it down or it silently
//   banks a slot for the next route that ships without a heartbeat. Re-derived
//   from the failing no-slack assertion, not by subtracting one.
// 2026-08-27 (sixth): 49 -> 47. `cron/lock-check-batch` and
//   `cron/run-insider-detectors`, converted together and chosen on MEASURED KILL
//   RISK rather than convenience: over 7 days their p90 `duration_ms` runs at
//   **80%** and **75%** of their own 300,000 ms ceilings (241,381 ms and
//   224,193 ms), the two highest of any un-converted route. A route whose p90 is
//   four fifths of its wall is the one where "killed" and "never fired" actually
//   diverge, so it is where a marker buys the most.
//   ⚠ Read off the failing no-slack assertion (49 -> 47), not by subtracting two.
//   ⚠ Noted while measuring, because it changes how the number is read: three
//   pipelines record a `duration_ms` ABOVE their route's `maxDuration`
//   (run-insider-detectors 322,813 ms, offers-sweep 339,605 ms, wmc-fmv-populate
//   352,922 ms, all against 300,000 ms). That is not a lambda outliving its wall
//   — `log_pipeline_run` has no `p_finished_at`, so `finished_at` defaults to the
//   INSERT and the duration absorbs retry/queueing on the terminal write.
//   **`duration_ms` on these routes is not execution time**, which is a second
//   argument for a marker whose timestamps are pinned by the helper.
// 2026-08-27 (seventh): 47 -> 42, and it is TWO changes, recorded separately
//   because only one of them is a conversion.
//   (a) FOUR conversions, chosen by the ratchet's own priority rule — routes on
//       `pipeline_cadence_watchlist WHERE is_active`, where a kill is not merely
//       unlogged but ACTIVELY MISREAD as "never fired": `candy-sales-indexer`
//       (HIGH, 450 min), `wmc-fmv-populate` (6,194 terminal rows, the largest
//       population left), `offers-sweep` (120 min) and `topshot-fmv-populate`
//       (480 min). ⚠ NOT chosen by p90 `duration_ms` this time: that signal is
//       corrupted, as the sixth entry above warns — `topshot-active-listings-ingest`
//       records a p90 of 959,294 ms against a 60 s wall, which is `finished_at`
//       defaulting to the INSERT, not execution time.
//   (b) ONE EXEMPTION, not a conversion: `wallet-backfill-multicollection` was
//       being counted as missing while being correctly instrumented under the
//       `-dispatch`/`-complete` convention it hand-rolled before the helper
//       existed. ⚠ That over-count was NOT harmless — the remedy this ratchet
//       prescribes is "add a marker", so the next session working the list would
//       have bolted a SECOND marker onto the fleet's highest-volume pipeline.
//   ⚠ Read off the failing no-slack assertion (42), not by subtracting five.
// 2026-08-29: 41 -> 40. `app/api/ingest/route.ts` converted (register R68). It had
// logged two SUB-steps and never its own outcome, so `pipeline='ingest'` returned
// zero rows over 48 h on the fleet's highest-volume endpoint; it now writes both
// the heartbeat and a terminal row under its own name.
// 2026-09-02 (eighth): 40 -> 37. THREE conversions, chosen on measured MARGIN
//   against each route's own wall rather than on convenience, and read from
//   `pipeline_runs` (73 h retention) on 2026-09-02:
//     `cron/allday-lock-refresh-batch` (allday-lock-refresh, watchlist 120 min) —
//       the tightest margin in the fleet: **71 of 73 ticks finish between
//       270,077 ms and 292,225 ms against a 300,000 ms wall**, worst 97.4%. That
//       is structural, not a spike: SOFT_DEADLINE_MS is 270,000, so every tick
//       stops with 30 s left and the measured tail already eats 22.2 of them.
//     `wallet-backfill` (watchlist severity HIGH, 800 min) — p90 is a quiet
//       48,222 ms but the maximum is 261,273 ms, 87% of the wall and one second
//       past its own soft deadline. The risk is the whale, not the median.
//     `cron/populate-pinnacle-wmc-fmv` (watchlist 180 min) — max 230,416 ms, 77%
//       of the wall, and the tick is ONE RPC call: nothing to break out of, so a
//       slow pass either returns or is killed with nothing written.
//   ⚠ `duration_ms` on an after() route absorbs the terminal write's own latency
//   (the sixth entry above), so these are UPPER bounds — which is the direction
//   that matters here, because the question is whether a tick can reach the wall.
//   ⚠ Read off the failing no-slack assertion (40 -> 37), not by subtracting three.
// 2026-09-02 (ninth): 37 -> 33. FOUR more, and the selection rule shifted from
//   "watchlisted" to "closest to its own wall", because the watchlisted tier no
//   longer contains the routes at risk — the tightest margin left among them is
//   `topshot-listing-cache` at 4% of a 300 s wall. All four figures below are
//   `max(duration_ms)` over the 73 h `pipeline_runs` retains, read 2026-09-02:
//     `cron/resolve-topshot-stubs`  29,313 ms of a **30,000 ms** wall — 97.7%,
//       the smallest wall in the fleet, with three more ticks in the 21.8–25.2 s
//       band. ⭐ AND THE MAXIMUM IS CENSORED AT THE WALL BY CONSTRUCTION: a tick
//       that crossed 30 s wrote nothing, so it is ABSENT from the distribution
//       rather than at the top of it, and the recorded max can never exceed the
//       ceiling however often the ceiling is hit. Not watchlisted, so a kill
//       here is not misread — it is unobserved by anything.
//     `check-alerts`               37,415 ms of 60,000 — 62%, and it is the
//       ALERTING route: a killed tick sends no mail, no Telegram and writes no
//       row, so its failure mode is SILENCE. Worst case on the fleet.
//     `cron/refresh-conflated-editions` 79,059 ms of 120,000 — 66%, on all
//       three of the ticks a daily job leaves inside the retention window.
//     `cron/alerts-send`           23,067 ms of 60,000 — 38%, on a 10-minute
//       cadence, so the tail is sampled often; output is outbound mail.
//   ⚠ The last two build their OWN supabase client, so the helper's `db`
//   argument is passed explicitly — its default would be a different connection.
//   ⚠ Read off the failing no-slack assertion (37 -> 33), not by subtracting four.
const BUDGET = 33

describe("after() routes that log a pipeline run must write an invocation heartbeat", () => {
  it(`is at or below the frozen budget of ${BUDGET}`, () => {
    expect(
      MISSING.length,
      `${MISSING.length} after() route(s) write a terminal pipeline_runs row with no invocation ` +
        `heartbeat, budget ${BUDGET}. A killed tick on these is indistinguishable from a cron ` +
        `that never fired. Convert one with writeInvocationHeartbeat() from ` +
        `lib/pipeline/heartbeat.ts and LOWER the budget in the same commit:\n  ` +
        MISSING.map((r) => r.rel).join("\n  "),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("has NO SLACK — the budget equals the live count", () => {
    // ⚠ A ratchet with headroom silently licenses the next N additions. This
    // repo paid for that with a ~13-point unguarded branch buffer on the
    // component gate. If this fails LOW, lower BUDGET; that is the success case.
    expect(
      MISSING.length,
      `BUDGET is ${BUDGET} but the live count is ${MISSING.length}. If lower, a conversion landed ` +
        `without lowering the budget — lower it now rather than banking the slack.`,
    ).toBe(BUDGET)
  })

  it("is not vacuous — the walk found routes, and found some that DO have a heartbeat", () => {
    // ⚠ Every clause of the predicate can fail silently. A renamed helper, a
    // changed `after` spelling, or a broken walk all produce a clean-looking
    // pass. Assert each stage found something.
    expect(ROUTES.length, "the app/api walk found no routes at all").toBeGreaterThan(400)
    expect(QUALIFYING.length, "no route matched after() + a terminal pipeline_runs write").toBeGreaterThan(50)
    expect(
      QUALIFYING.length - MISSING.length,
      "no route uses writeInvocationHeartbeat — the helper name probably changed, which would " +
        "make every route look non-compliant and this ratchet's budget meaningless",
    ).toBeGreaterThan(0)
  })

  it("the five converted routes are the ones that have it", () => {
    // Names the compliant set, not the violating one — so the assertion gets
    // STRONGER as routes are converted rather than needing an edit per rename.
    // ⚠ A guard that names its instances dies on a rename; these five are named
    // because they are the seed set the helper was extracted from, and the
    // `toContain` direction means a NEW compliant route never reds this.
    const compliant = QUALIFYING.filter((r) => r.hasHeartbeat).map((r) => r.rel)
    for (const seed of [
      "app/api/fmv-recalc/route.ts",
      "app/api/admin/drain-fmv-cold-tail/route.ts",
      "app/api/candy-listings-indexer/route.ts",
      "app/api/ingest/candy-editions/route.ts",
      "app/api/ingest/candy-offers/route.ts",
    ]) {
      expect(compliant, `${seed} lost its heartbeat`).toContain(seed)
    }
  })
})

describe("the -dispatch/-complete exemption is a PROPERTY, not a name", () => {
  // Added with the exemption itself so it cannot quietly decay into a suffix
  // match. A `-dispatch` alone must never vouch for a route: `alerts-dispatch`
  // is a real pipeline whose name merely ends that way, and a suffix-only rule
  // would silently excuse every route that logs it.
  const hasMarkerPair = (code: string) =>
    /["'`][a-z0-9-]+-dispatch["'`]/.test(code) && /["'`][a-z0-9-]+-complete["'`]/.test(code)

  it("requires BOTH halves — a -dispatch alone does not vouch for a route", () => {
    expect(hasMarkerPair('p_pipeline: "thing-dispatch"')).toBe(false)
    expect(hasMarkerPair('p_pipeline: "thing-complete"')).toBe(false)
    expect(hasMarkerPair('"thing-dispatch" ... "thing-complete"')).toBe(true)
  })

  it("NEGATIVE CONTROL: a route logging only `alerts-dispatch` is NOT exempted", () => {
    expect(hasMarkerPair('const PIPELINE_NAME = "alerts-dispatch";')).toBe(false)
  })

  it("exempts exactly one route today, and it is the one that hand-rolled the pair", () => {
    // A count assertion, so a future route silently picking up the exemption is
    // visible rather than absorbed.
    const exempted = QUALIFYING.filter(
      (r) => r.hasHeartbeat && !/writeInvocationHeartbeat\s*\(/.test(readFileSync(path.join(ROOT, r.rel), "utf8")),
    )
    expect(exempted.map((r) => r.rel)).toEqual(["app/api/wallet-backfill-multicollection/route.ts"])
  })
})

describe("the helper is not a museum piece", () => {
  it("lib/pipeline/heartbeat.ts has real production callers, not just tests", () => {
    // ⚠ THE DEFECT THIS PREVENTS IS ONE THIS REPO ALREADY HAS ELSEWHERE, and it
    // is invisible in every coverage number. `supabase/functions/_shared`'s four
    // pack-EV modules are fully tested and imported by NOTHING in production —
    // the 1,583-line edge function they mirror computes the +EV badge inline —
    // so they measure as covered while the shipped code is untested. A `lib/`
    // module whose only importers are tests is worse than no module: it reads as
    // shared infrastructure in a grep and is dead weight in fact.
    //
    // Counted rather than merely asserted non-empty, so an accidental mass
    // revert of the conversions reds here as well as on the budget.
    const callers = QUALIFYING.filter((r) => r.hasHeartbeat).map((r) => r.rel)

    expect(
      callers.length,
      "lib/pipeline/heartbeat.ts has no production caller — it would be a tested " +
        "module that nothing ships, the shape `_shared`'s pack-EV mirrors already have",
    ).toBeGreaterThan(0)
    // The seed set alone is five; anything at or below that means conversions
    // were reverted without the budget moving.
    expect(callers.length).toBeGreaterThanOrEqual(5)
  })
})

describe("nobody re-rolls the heartbeat by hand", () => {
  it("no route writes a '-heartbeat' pipeline_runs row without the helper", () => {
    // ⚠ The failure this catches is a REGRESSION TO THE STARTING STATE: a sixth
    // hand-rolled copy, which is how the first five diverged. The helper is the
    // only place the row shape is decided.
    const rogue = ROUTES.filter((r) => {
      const code = stripComments(readFileSync(path.join(ROOT, r.rel), "utf8"))
      return /-heartbeat/.test(code) && !r.hasHeartbeat
    })

    expect(
      rogue.map((r) => r.rel),
      "these routes name a '-heartbeat' pipeline without going through " +
        "lib/pipeline/heartbeat.ts — use writeInvocationHeartbeat() so the row shape stays one decision",
    ).toEqual([])
  })

  it("no route writes an invocation marker under its OWN pipeline name", () => {
    // ⚠ THE WORST SHAPE, AND IT LOOKS LIKE THE FIX. Four routes wrote a
    // `phase: "invoked"` marker under their real pipeline name, each with a
    // careful comment explaining that it made a dropped after() distinguishable
    // from a cron that never fired. It did — and it simultaneously DESTROYED the
    // alarm, because `detect_stalled_pipelines()` computes
    //   max(started_at) FROM pipeline_runs WHERE pipeline = w.pipeline
    // with NO phase filter. A self-named marker refreshes `last_run` every tick,
    // so the cadence arm can never fire however many after() bodies die. A
    // monitor whose input set includes its own output.
    //
    // Measured over the ~72h retention window before the fix:
    //   allday-pack-listings   212 markers / 208 completions — 6 dead ticks, all
    //                          invisible behind a 90-min arm
    //   classify-acquisitions   70 markers / 122 rows, 180-min arm
    //   pinnacle-sync            3 markers /   0 completions, 1560-min arm
    //   compute-laliga-pack-ev   3 markers /   0 completions
    //
    // ⚠ A BAN AT POPULATION ZERO, not a ratchet — this repo prefers one, and it
    // costs no allowlist. The marker itself is right; only the NAME was wrong,
    // and `writeInvocationHeartbeat` cannot get the name wrong.
    // ⚠ THE PREDICATE IS `"invoked"` ONLY, AND THAT NARROWING IS DELIBERATE —
    // the first draft also matched `phase: "started"` and mis-sorted a route
    // that is NOT doing this. `app/api/admin/drain-conflated-subeditions`
    // inserts a `phase: "started"` row with **ok: false** and then UPDATEs that
    // SAME row to completion. It is not a phantom second row: there is one row
    // per run, it stays ok:false until the run finishes, and a maxDuration kill
    // correctly leaves it ok:false with `error: "started (no completion
    // recorded…)"`. Nothing is suppressed, and the row carries progressive
    // `last_step` telemetry that is the only diagnosis available on a kill.
    // Banning it would force a rewrite of a design that is already right.
    //
    // So the discriminator is not the word — it is whether a SEPARATE, ok:true
    // row is minted under the real pipeline name. All four defects spelled that
    // `phase: "invoked"`. Ban the spelling that only the defect uses, and say
    // out loud what is excluded, rather than write a cleverer regex that sorts
    // the two apart by accident.
    const selfNamed = ROUTES.filter((r) => {
      const code = stripComments(readFileSync(path.join(ROOT, r.rel), "utf8"))
      return /phase:\s*["']invoked["']/.test(code)
    })

    expect(
      selfNamed.map((r) => r.rel),
      "these routes write an invocation marker inline. Route it through " +
        "writeInvocationHeartbeat() from lib/pipeline/heartbeat.ts so it lands under " +
        "<pipeline>-heartbeat — a marker under the pipeline's own name silences " +
        "detect_stalled_pipelines() on the exact outage it was added to expose",
    ).toEqual([])
  })

  it("no route reaches log_pipeline_run for a heartbeat row", () => {
    // `log_pipeline_run` has no `p_finished_at`, so `finished_at` takes its
    // `now()` default and `duration_ms` (GENERATED from the pair) publishes the
    // call's own latency — measured live at up to 47,462 ms on three candy
    // markers before they were converted. The RPC route to a heartbeat is
    // structurally unable to be correct; ban it rather than document it again.
    const viaRpc = ROUTES.filter((r) => {
      const code = stripComments(readFileSync(path.join(ROOT, r.rel), "utf8"))
      return /p_pipeline:\s*`?\$?\{?[^,]*-heartbeat/.test(code)
    })

    expect(viaRpc.map((r) => r.rel)).toEqual([])
  })
})
