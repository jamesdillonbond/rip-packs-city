import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

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
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:'"`\\])\/\/[^\n]*/g, "$1 ")
}

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
    hasHeartbeat: /writeInvocationHeartbeat\s*\(/.test(code),
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
// Lower this in the SAME commit that converts a route. Never raise it.
const BUDGET = 66

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
