import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// ─────────────────────────────────────────────────────────────────────────────
// A ROUTE THAT ALREADY KNOWS HOW TO ANSWER A FAILED READ MUST ALSO BOUND IT.
//
// ⭐ THE GAP THIS FILLS, MEASURED 2026-09-03 RATHER THAN ASSUMED.
// `scripts/check-unbounded-server-reads.mjs` drove this class to zero and holds
// there — but it inspects **183 page/layout files and NO API routes**. That is
// not a glob drawn too narrowly; it is a guard about server PAGES doing its job
// perfectly. The gap is that the SAME class has a ban at zero for pages and, until
// this file, **no instrument at all for API routes**:
//
//   app/api/**/route.ts(x)                                          499
//   …that read Supabase (`.rpc("…")` / `.from("…")`)                359
//   …with no budget primitive anywhere in the file                  273
//
// ⓘ CLAUDE.md predicted exactly this hole: *"an exclusion justified by ANOTHER
// instrument is a claim about it — two guards skipped `app/api` as 'in the
// primary gate'; coverage sees whether lines RUN, not whether `error` is
// handled."*
//
// ── WHY THIS POPULATION AND NOT ALL 273 ────────────────────────────────────
// 273 is an upper bound on a set with wildly different blast radii. A cron or
// ingest route that hangs fails LOUDLY — an absent or `ok:false` `pipeline_runs`
// row, watched by the sentinel. A route a human is waiting on returns a **504**,
// which is the honesty class this repo tracks.
//
// So the population is derived from the route's OWN code: a route that imports
// `apiErrorResponse()` or `boardUnavailable()` has already decided it owes the
// caller an honest answer on a failed read. **A route that knows that and does
// not bound the read cannot deliver it** — the platform kills the function first
// and the caller gets a 504 instead of the degraded answer sitting three lines
// below. That is the property, and it is read off the file rather than off a
// list of paths.
//
// 🚨 THE PREDICATE WAS WRONG ONCE, IT VOUCHED FOR THE MOTIVATING CASE, AND THAT
// IS WORTH MORE THAN THE COUNT. The first draft counted `AbortSignal.timeout` /
// `new AbortController` as a bound — and `/api/sniper-feed`, the route this file
// exists because of, passed on the strength of a **6,000 ms bound on an HTTP
// call at line 550**, which has nothing to do with its four unbounded Supabase
// RPCs. That is precisely the trap `lib/pack-dist/fetchers.ts` records against
// itself — *"one bounded read vouching for thirteen bare siblings"* — reproduced
// in the guard written after reading it.
//
// ⭐ SO THE PATTERN IS DB-SPECIFIC. `withBoardBudget` / `withPagedBoardBudget` /
// `rpcWithRetry` / supabase-js's own `.abortSignal()`. An `AbortSignal` bounds a
// `fetch`; supabase-js reads are not fetches as far as this question goes.
//
// ⛔ AND WITH THE CORRECT PATTERN THE NUMBER IS NOT 129, IT IS 131 OF 131:
// **not one route in this population bounds the read it has promised to degrade
// on.** The 129 was the wrong predicate flattering the tree by two.
//
// ⚠ IT IS A RATCHET, NOT A BAN, AND THE NUMBERS SAY WHY. A ban would be a
// 131-route change in one commit on the most user-facing surface in the tree; a
// frozen ceiling that can only fall is the honest instrument for that.
//
// ⚠ WHAT THIS CANNOT SEE, stated so a green run is not over-read:
//   • File-level presence. A route with ONE bounded read and six bare ones
//     passes. `lib/pack-dist/fetchers.ts` records that exact asymmetry against
//     itself — *"ONE read here was already bounded and THIRTEEN were not"* — and
//     warns that a module-level check would clear the whole page on it.
//   • Whether the bound is HONOURED, or what the route answers when it fires.
//     `image-proxy-routes-bound-their-upstream` pairs its source check with
//     behavioural cases for that reason; this file is the source half only.
//   • A read reached through a `lib/` helper. Same one-level-deep blindness that
//     hid five routes from the heartbeat ratchet until 2026-09-03.
//
// ⛔ AND IT DOES NOT PRESCRIBE A VALUE. A 300 s drain and a 5 s board read need
// different budgets; the property is that SOME bound exists, never which.
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = process.cwd()
const API = path.join(ROOT, "app", "api")
const LIB = path.join(ROOT, "lib")

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) tsFiles(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/** How many `lib/` modules use a DB budget primitive — the detector's own control. */
function libFilesUsingABound(): number {
  return tsFiles(LIB).filter((f) => BOUNDED.test(stripComments(readFileSync(f, "utf8")))).length
}

function routes(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) routes(full, out)
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full)
  }
  return out
}

/** A Supabase read with a literal target — the shape `.select()` alone cannot confirm. */
const READS_SUPABASE = /\.rpc\s*\(\s*["'`]|\.from\s*\(\s*["'`]/

/** The route has decided it owes the caller an honest answer on a failed read. */
const DEGRADES_HONESTLY = /apiErrorResponse\s*\(|boardUnavailable\s*\(/

/**
 * Anything that puts a ceiling on a DATABASE read.
 *
 * ⛔ `AbortSignal.timeout` and `new AbortController` are deliberately ABSENT.
 * They bound a `fetch`, and including them let `/api/sniper-feed` pass on an
 * HTTP bound while four Supabase RPCs ran unbounded — see the header.
 *
 * ⭐ PREDICATE CHANGE 2026-09-04, and it LOWERS the budget rather than raising
 * it, so it is stated at least as loudly. `boundedRead` (`lib/api/bounded-read.ts`)
 * is the API-route flavour of `withBoardBudget`: it RESOLVES into the
 * `{ data, error }` envelope these routes already destructure instead of
 * rejecting, because — unlike every `/insights` server page — the shape here is
 * a bare `const { data, error } = await supabase.rpc(…)` with NO try/catch, and
 * a rejection there converts a slow read into an unhandled 500 that the route's
 * own honest-error helper never gets to classify.
 *
 * ⚠ A NEW SPELLING IN THIS PATTERN IS THE ONE CHANGE THAT CAN LOWER THIS
 * NUMBER WITHOUT ANY ROUTE IMPROVING, so it is admitted on evidence, not on
 * naming: `__tests__/lib-api-bounded-read.test.ts` drives reads that NEVER
 * settle and asserts they resolve into `{ data: null, error }`, and three of its
 * cases HANG (vitest wall) against the helper with its `Promise.race` removed.
 * Do not add a fourth spelling here without the equivalent behavioural proof.
 */
const BOUNDED = /withBoardBudget|withPagedBoardBudget|rpcWithRetry|boundedRead\s*\(|\.abortSignal\s*\(/

interface Row {
  rel: string
  bounded: boolean
}

const POPULATION: Row[] = routes()
  .map((full) => ({
    rel: path.relative(ROOT, full).split(path.sep).join("/"),
    // ⚠ Comments stripped FIRST. Every converted route in this repo carries a
    // long comment ABOUT its bound, and several route headers quote
    // `apiErrorResponse` in prose — unstripped, this walk would count the
    // documentation as the code in both directions at once.
    code: stripComments(readFileSync(full, "utf8")),
  }))
  .filter((f) => READS_SUPABASE.test(f.code) && DEGRADES_HONESTLY.test(f.code))
  .map((f) => ({ rel: f.rel, bounded: BOUNDED.test(f.code) }))

const UNBOUNDED = POPULATION.filter((r) => !r.bounded)

/**
 * Measured 2026-09-03: **131** API routes both read Supabase and use an
 * honest-error helper, and **131** of them bound nothing. Lower this when you
 * bound one. NEVER raise it — except as a POPULATION CORRECTION, which must name
 * the predicate change that caused it, exactly as the heartbeat ratchet's
 * 31 → 35 does.
 *
 * ⭐ 130 → 42 on 2026-09-04, in three passes: **89 read-only routes converted**
 * — 84 to `boundedRead`
 * (`lib/api/bounded-read.ts`) and **4 to `withPagedBoardBudget`** — the four
 * paged `/insights` boards, whose `fetchAllPaged` returns the very
 * `{ rows, error }` contract that helper was written to match. Population
 * and **1 to `withBoardBudget`** — `/api/public/special-serial-owners`, whose
 * read goes through a `lib/` fetcher already inside a try/catch, so the
 * REJECTING flavour lands exactly where a failed read is handled. Population
 * unchanged at 131 throughout. Two of the 89 are
 * the ones production actually named — `/api/profile/hero-moment` (three
 * `57014` statement timeouts on `/dashboard`, the primary signed-in surface)
 * and `/api/wallet/pack-lifecycle`.
 *
 * 🚨 THE REMAINING 42 ARE NOW *EXACTLY* THE DELIBERATE EXCLUSION SET — every
 * read-only route in this population is bounded, and the number will not fall
 * further without a decision. All 42 export a POST/PUT/PATCH/DELETE or live
 * under `cron|admin|backfill|badge-sync|seed-|ingest`, and **bounding a WRITE
 * is not the same trade as
 * bounding a read**: this bound abandons the WAIT, not the statement, so a
 * write that overruns would be reported to the caller as failed while Postgres
 * commits it — manufacturing exactly the false claim the honesty canon exists
 * to prevent, in the one direction where the caller cannot re-read to find out.
 * A write needs an idempotency key or a status re-read, not a timer.
 *
 * ⛔ **SO DO NOT DRIVE THIS TO ZERO.** A future reader seeing 42 on a ratchet
 * that only ever falls will be tempted to finish the job; finishing it means
 * wrapping the writes, which is the one change this file exists to argue
 * against. If a write route ever does need a bound, it needs a DIFFERENT
 * mechanism and this budget should be re-derived, not decremented.
 */
const BUDGET = 42

describe("an API route that degrades honestly also bounds the read it degrades on", () => {
  it("is not vacuous — and the check is SATISFIABLE AT A POPULATION OF ZERO", () => {
    // ⚠ The obvious non-vacuity assertion — "some route in the population IS
    // bounded" — is unavailable here, because none is. Asserting it would make
    // the guard fail on the state it exists to describe, and CLAUDE.md bans
    // exactly that: *a not-vacuous check must be satisfiable at a population of
    // ZERO, or the guard punishes its own success.* So the detector is proved
    // live from OUTSIDE the population instead.
    expect(POPULATION.length, "no route both reads Supabase and degrades honestly").toBeGreaterThan(50)
    expect(
      libFilesUsingABound(),
      "no file under lib/ uses a DB budget primitive — the BOUNDED pattern is dead, and every " +
        "route would read as unbounded for that reason alone",
    ).toBeGreaterThan(5)
  })

  it(`is at or below the frozen budget of ${BUDGET}`, () => {
    expect(
      UNBOUNDED.length,
      `${UNBOUNDED.length} API route(s) call apiErrorResponse()/boardUnavailable() — so they have ` +
        `already decided they owe the caller an honest answer on a failed read — while bounding no ` +
        `read at all. Unbounded, the platform kills the function before that answer can be sent and ` +
        `the caller gets a 504 instead. Bound one (withBoardBudget resolves rather than rejects, so ` +
        `it routes into the if (error) branch the route already has) and LOWER the budget in the ` +
        `same commit.`,
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("has NO SLACK — the budget equals the live count", () => {
    // A ratchet with headroom silently licenses the next N additions. If this
    // fails LOW, lower BUDGET; that is the success case.
    expect(
      UNBOUNDED.length,
      `BUDGET is ${BUDGET} but the live count is ${UNBOUNDED.length}. If lower, a conversion landed ` +
        `without lowering the budget — lower it now rather than banking the slack.`,
    ).toBe(BUDGET)
  })

  it("⛔ the MOTIVATING route is OUTSIDE this population, and that is stated rather than hidden", () => {
    // `/api/sniper-feed` is why this file exists — 3 × 504 in 24 h against
    // 455 × 200, and a 6,898 ms MEAN on `get_topshot_sniper_deals` over 6,746
    // calls. It is NOT in the population, because it never calls
    // `apiErrorResponse()`/`boardUnavailable()`: it has not committed to an
    // honest answer, so this guard's premise does not apply to it.
    //
    // ⭐ That is a real limitation and the reason it is a test rather than a
    // sentence: the wider set (reads Supabase, NO honest helper) is ~228 routes
    // and has no instrument at all. Anyone reading a green run here should know
    // the route that prompted it is not covered.
    const sniper = POPULATION.find((r) => r.rel === "app/api/sniper-feed/route.ts")
    expect(
      sniper,
      "sniper-feed is now in the population — it must have gained an honest-error helper, so " +
        "re-derive this case and the budget rather than deleting it",
    ).toBeUndefined()
  })
})
