import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

/**
 * THE COMPLEMENT OF THE READ-BOUND RATCHET — the routes that one cannot see.
 *
 * ── WHY A SECOND FILE AND NOT A WIDER PREDICATE IN THE FIRST ────────────────
 * `api-routes-that-degrade-honestly-also-bound-their-reads` defines its
 * population as *routes that call `apiErrorResponse()`/`boardUnavailable()`* —
 * "the route has decided it owes the caller an honest answer". That is a good
 * population for a ban-shaped argument, and it is why that file can say its
 * remaining 42 are exactly the deliberate write-only exclusion set.
 *
 * 🚨 But a population defined by a HELPER is a claim about every route that
 * handles errors some other way, and 360 of 500 route files read Supabase while
 * only 131 are in that population. The other 229 were never exempted — they were
 * never LOOKED AT. Measured 2026-09-04: **28 read-only routes outside it bound
 * nothing at all**, including `/api/search` and `/api/collection-stats`, the
 * latter one of the saturation symptoms CLAUDE.md names by name.
 *
 * ⭐ This is the same gap, one directory over, that
 * `og-cards-bound-their-database-reads` was written for on the same day: an OG
 * card returns `null` rather than calling `apiErrorResponse`, so all 16 of its
 * DB reads sat outside that ratchet **by construction, not by exemption**. Two
 * instances in one evening is what made it worth counting rather than fixing
 * twice. CLAUDE.md's rule: *an exclusion justified by ANOTHER instrument is a
 * claim about it — check that one can SEE the property.*
 *
 * ── ⛔ WHY THIS IS A RATCHET AND MUST NOT BE DRIVEN TO ZERO MECHANICALLY ─────
 * This is the part that matters more than the number. Bounding a read is only an
 * improvement when the route's error path is HONEST. Several of the remainder
 * degrade with `?? []` / `?? 0` and no `if (error)` branch at all — and for those
 * a bound converts a HANG into a FABRICATED EMPTY, which is strictly worse: a
 * timeout at least tells the caller something failed, while `[]` is a confident
 * false claim, the defect class this repo is most burned by.
 *
 * So the remaining routes need a per-route decision — fix the error path FIRST,
 * then bound — and a future reader who "finishes the job" with a mechanical
 * sweep would ship that defect at every one of them at once. The seven converted
 * on 2026-09-04 were chosen precisely because each already had `if (error)` →
 * an error response, so a timeout lands on a branch that was already honest.
 *
 * ⚠ `app/api/acquisition-stats` is the worked example and its own header records
 * it: its collection-id helper falls back to `TOPSHOT_COLLECTION_ID` on failure,
 * so a bound there would make one collection's stats answer under another
 * collection's label MORE often. Its main RPC was bounded; that helper was not.
 *
 * ── 🚨 THE COUNT IS A CEILING, NOT A CENSUS — IT SEES ONLY CLIENT-SIDE BOUNDS ─
 * Checked 2026-09-04, hours after this file was written, by reading the DB
 * instead of trusting the guard: **`BOUNDED` above matches only bounds written
 * in TypeScript.** A route whose RPC declares its own `statement_timeout` is
 * bounded — and bounded BETTER, because a function-local timeout CANCELS the
 * statement, while `boundedRead` only abandons the wait and leaves the query
 * running. Measured against `pg_proc.proconfig`, 5 of the 25 RPCs these routes
 * call carry one, and for **two routes that covers every read they make**:
 *
 *   • `app/api/profile/collection-stats` → `get_wallet_collection_stats` (20s).
 *     Its header already documents the pairing: `maxDuration = 30` "MUST stay
 *     above the RPC's own statement_timeout … or the lambda dies first on a cold
 *     whale wallet and the caller never sees the 57014 -> 503."
 *   • `app/api/sets` → `get_topshot_set_detail` + `get_topshot_set_progress`
 *     (25s each).
 *
 * ⛔ **DO NOT "FIX" THOSE TWO.** Wrapping an already-cancelling read in a client
 * timer adds a second, shorter deadline that abandons the wait before Postgres
 * cancels the work — strictly worse than what is there.
 *
 * ⚠ They are NOT exempted in code, deliberately. An exemption list here would be
 * a claim about `pg_proc` that a source-level test cannot verify — the exact trap
 * this file was written about, pointed at itself. So they stay counted, the
 * budget carries them, and the ceiling is documented instead. ⚠ Those timeout
 * values are a DATED SAMPLE; re-read `pg_proc.proconfig` before quoting them.
 *
 * ── WHAT THIS FILE CANNOT SEE, stated so a green run is not over-read ────────
 *   • A DB-side `statement_timeout` (above) — so the number OVERSTATES the gap.
 *   • Reads reached through a `lib/` helper (the same one-level blindness the
 *     sibling ratchet documents against itself).
 *   • File-level only: a route with one bounded read and three bare ones counts
 *     as bounded here, exactly as it does there.
 *   • Whether a bound is HONOURED, or what the route answers when it fires.
 */

const ROOT = process.cwd()
const API = path.join(ROOT, "app", "api")

function routes(dir = API, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) routes(full, out)
    else if (entry === "route.ts" || entry === "route.tsx") out.push(full)
  }
  return out
}

/** Copied VERBATIM from the sibling ratchet so this is exactly its complement. */
const READS_SUPABASE = /\.rpc\s*\(\s*["'`]|\.from\s*\(\s*["'`]/
const DEGRADES_HONESTLY = /apiErrorResponse\s*\(|boardUnavailable\s*\(/
const BOUNDED = /withBoardBudget|withPagedBoardBudget|rpcWithRetry|boundedRead\s*\(|\.abortSignal\s*\(|OG_FETCH_TIMEOUT_MS/

/**
 * The sibling ratchet's stated deliberate exclusion: a WRITE must not be bounded
 * by a timer, because this bound abandons the WAIT and not the statement — a
 * write reported failed while Postgres commits it manufactures the very false
 * claim the canon exists to prevent, in the one direction the caller cannot
 * re-read to resolve.
 */
const WRITE_OR_JOB = /\b(POST|PUT|PATCH|DELETE)\b|\/(cron|admin|backfill|badge-sync|seed-|ingest)/

interface Row {
  rel: string
  bounded: boolean
}

const ALL = routes()
const READERS: Row[] = []
const POPULATION: Row[] = []
for (const full of ALL) {
  const rel = path.relative(ROOT, full).split(path.sep).join("/")
  const code = stripComments(readFileSync(full, "utf8"))
  if (!READS_SUPABASE.test(code)) continue
  READERS.push({ rel, bounded: BOUNDED.test(code) })
  if (DEGRADES_HONESTLY.test(code)) continue // the sibling ratchet's ground
  if (WRITE_OR_JOB.test(code + " " + rel)) continue // deliberately not bounded
  POPULATION.push({ rel, bounded: BOUNDED.test(code) })
}
const UNBOUNDED = POPULATION.filter((r) => !r.bounded)

/**
 * Measured 2026-09-04: **28**.
 *
 * → **21** by bounding the seven whose error path was already honest:
 *   `/api/search`, `/api/collection-stats`, `/api/platform-stats`,
 *   `/api/collection-readiness`, `/api/cross-collection-deals`,
 *   `/api/public/wallet-intel`, `/api/acquisition-stats`.
 * → **20** by `/api/profile/me`.
 *
 * ⭐ `/api/profile/me` is the worked example of the RIGHT way to take one off
 * this list, and it needed no error-path fix at all: it already set
 * `identity_degraded` on every read error — the honest distinction between "you
 * have no wallet on file" and "we could not read whether you do". What it could
 * not do was REACH that branch on a read that merely hung, and its own header
 * argues at length that a 5xx here is worse than a degraded 200 (it renders a
 * signed-in reader as ANON on every public board that calls this
 * unconditionally). Bounding it made the design it already documented reachable.
 * Proven behaviourally, not structurally: the new cases in
 * `api-profile-me.test.ts` TIME OUT against the unbounded route.
 *
 * ⚠ DOWN ONLY, and ⛔ **only behind a per-route reading of what that route
 * answers on a failed read** — see the header. Raising it is a POPULATION
 * CORRECTION and must name the predicate change that caused it.
 */
const BUDGET = 20

describe("read-only API routes outside the honest-error population are counted", () => {
  it("is not vacuous — the walk found a real tree and a real complement", () => {
    expect(ALL.length, "no route files found — the walker is broken").toBeGreaterThan(200)
    expect(READERS.length, "no route reads Supabase — the read detector is broken").toBeGreaterThan(100)
    expect(
      POPULATION.length,
      "the complement is empty, which would mean every Supabase-reading route calls " +
        "apiErrorResponse — if that ever becomes true, delete this file rather than " +
        "letting it pass vacuously",
    ).toBeGreaterThan(10)
  })

  it("proves its own detector in both directions", () => {
    const honest = `const { data, error } = await sb.rpc("x", {}); if (error) return apiErrorResponse(error, "y")`
    const outside = `const { data, error } = await sb.rpc("x", {}); if (error) return NextResponse.json({ error: "no" }, { status: 500 })`
    const boundedSrc = `const { data, error } = await boundedRead(sb.rpc("x", {}), "z")`
    expect(READS_SUPABASE.test(honest) && DEGRADES_HONESTLY.test(honest)).toBe(true)
    expect(READS_SUPABASE.test(outside) && DEGRADES_HONESTLY.test(outside)).toBe(false)
    expect(BOUNDED.test(outside)).toBe(false)
    expect(BOUNDED.test(boundedSrc)).toBe(true)
  })

  it(`is at or below the frozen budget of ${BUDGET}`, () => {
    expect(
      UNBOUNDED.length,
      `${UNBOUNDED.length} read-only API route(s) read Supabase, are invisible to the ` +
        `apiErrorResponse-keyed ratchet, and bound nothing:\n` +
        UNBOUNDED.map((r) => `  ${r.rel}`).join("\n") +
        `\n\n⛔ Do NOT bulk-wrap these. Read what each answers on a failed read first: ` +
        `several degrade with ?? [] and no if (error) branch, and a bound there turns a ` +
        `hang into a confident empty list. Fix the error path, THEN bound.`,
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("has NO SLACK — the budget equals the live count", () => {
    expect(
      UNBOUNDED.length,
      `BUDGET is ${BUDGET} but the live count is ${UNBOUNDED.length}. If lower, a conversion ` +
        `landed without lowering the budget — lower it now rather than banking the slack.`,
    ).toBe(BUDGET)
  })
})
