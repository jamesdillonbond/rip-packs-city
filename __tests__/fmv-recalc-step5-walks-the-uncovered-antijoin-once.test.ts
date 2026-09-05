import { describe, it, expect } from "vitest"
import { readFileSync } from "fs"
import path from "path"
import { stripCommentsWithState } from "../scripts/lib/strip-comments.mjs"

// ── ARCHITECTURE GUARD — fmv-recalc Step 5 walks its anti-join ONCE ─────────
//
// Step 5 ("backfill editions with zero FMV coverage") used to send TWO ad-hoc
// `query_sql` scans over the SAME `editions` × `fmv_snapshots` anti-join:
//
//   * a COUNT(*) whose ONLY consumer was a console.log — 101,407 buffers
//   * the candidate read                                — 106,598 buffers
//
// 208,005 buffers a tick at 151 ticks a day, on an instance whose ceiling is
// disk IO. Both are now one call to `fmv_recalc_uncovered_editions`
// (migration 20260905033723): 101,725 buffers, −51%, and — because `query_sql`
// is a generic wrapper that collapses EVERY caller into a single
// pg_stat_statements row (`track = top`, zero non-toplevel rows) — the scan
// finally has a queryid of its own.
//
// ⚠ WHAT THIS GUARD IS FOR. The regression it prevents is not "someone deletes
// the function". It is the ordinary, plausible edit: needing the census for
// something, not noticing the RPC already returns it, and adding a second
// COUNT(*) beside it. That reads as a one-line addition and silently doubles
// the step. So the property pinned here is ONE database call, not the presence
// of a name.
//
// ⚠ THE COMMENT-STRIP IS LOAD-BEARING AND PROVES ITSELF. The route's own
// comments in this region quote `query_sql` and `?? 0` verbatim — they are the
// text explaining why neither may appear in the CODE. So every ban below is
// unsatisfiable unless stripCommentsWithState actually stripped. A guard that
// can be satisfied by its own comment is the failure mode this file is written
// against; here a broken stripper turns the guard RED rather than green.

const REPO = process.cwd()
const ROUTE = path.join(REPO, "app", "api", "fmv-recalc", "route.ts")
const RAW = readFileSync(ROUTE, "utf8")

const START = "── Step 5: Backfill editions with zero FMV coverage"
const END = "── Step 5b: Historical sales fallback"

// ⚠ Both markers sit INSIDE `//` comments, so slicing at the marker TEXT cuts
// the region mid-comment and leaves the stripper in its "line" state — which is
// exactly what the endState assertion below caught. Cut on line boundaries.
function step5Raw(): string {
  const a = RAW.indexOf(START)
  const b = RAW.indexOf(END)
  if (a < 0) throw new Error(`Step 5 marker not found: ${START}`)
  if (b < 0) throw new Error(`Step 5b marker not found: ${END}`)
  if (b <= a) throw new Error("Step 5b precedes Step 5 — markers moved")
  const lineStart = (i: number) => RAW.lastIndexOf("\n", i) + 1
  return RAW.slice(lineStart(a), lineStart(b))
}

const RAW_REGION = step5Raw()
const stripped = stripCommentsWithState(RAW_REGION)
const CODE = stripped.code

describe("fmv-recalc Step 5: one anti-join, not two", () => {
  // ── (0) The instrument, before anything is measured with it ───────────────
  it("the region is non-trivial and the comment stripper terminated cleanly", () => {
    // A guard over an empty slice passes vacuously. Bound it from below.
    expect(RAW_REGION.length).toBeGreaterThan(2000)
    expect(
      { endState: stripped.endState, tplDepth: stripped.tplDepth },
      "stripCommentsWithState desynced — every ban below is reading the wrong " +
        "text, so treat this as the guard being broken, not the route.",
    ).toEqual({ endState: "code", tplDepth: 0 })
  })

  it("the stripper really removes a known offender (this region contains two)", () => {
    // Not a synthetic fixture: the route's own prose in this region quotes both
    // banned strings. If these survive stripping, the bans below are worthless.
    expect(RAW_REGION).toContain("query_sql")
    expect(RAW_REGION).toContain("?? 0")
    expect(CODE).not.toContain("query_sql")
    expect(CODE).not.toContain("?? 0")
  })

  // ── (1) The property: ONE database call ───────────────────────────────────
  it("makes exactly one .rpc() database call", () => {
    const calls = [...CODE.matchAll(/\.rpc\(\s*"([^"]+)"/g)].map((m) => m[1])
    expect(
      calls,
      "Step 5 must resolve the uncovered-edition census AND its candidate list " +
        "from a single call. A second call here is a second full anti-join over " +
        "editions × fmv_snapshots (~101K buffers, 151×/day).",
    ).toEqual(["fmv_recalc_uncovered_editions"])
  })

  it("sends no ad-hoc query_sql from this step (ban at zero, not an allowlist)", () => {
    const n = CODE.split('.rpc("query_sql"').length - 1
    expect(n).toBe(0)
  })

  // ⓘ A third ban — "no inline SQL naming both editions and fmv_snapshots" —
  // was written here and REMOVED rather than weakened. It could never pass: the
  // replacement function is itself called `fmv_recalc_uncovered_editions`, so
  // its own name matched the very pattern the ban searched for, next to the
  // legitimate `.from("fmv_snapshots")` writes this step must keep. It was also
  // redundant — with exactly one .rpc() call and zero query_sql, this region has
  // no channel left through which ad-hoc SQL could be sent.

  // ── (2) The census may not be fabricated ──────────────────────────────────
  it("falls back to null, never 0, when the census read fails", () => {
    expect(CODE).toContain("let uncoveredCensus: number | null = null")
    const assign = /uncoveredCensus\s*=\s*([^\n]+)/.exec(CODE)
    expect(assign, "the census assignment disappeared").not.toBeNull()
    expect(
      assign![1],
      "A failed count must stay null. `?? 0` here publishes a MEASURED zero — " +
        "'every edition is priced' — out of a read that never answered. That is " +
        "the fabricated-number shape, and supabase-js RETURNS errors rather than " +
        "throwing, so nothing else catches it.",
    ).toContain("?? null")
  })

  it("reports the census as unknown rather than as a number when it is null", () => {
    expect(CODE).toContain('uncoveredCensus ?? "unknown"')
  })
})

describe("fmv-recalc surfaces the census it already paid for", () => {
  const WHOLE = stripCommentsWithState(RAW)
  it("records uncovered_census in pipeline_runs.extra", () => {
    expect(WHOLE.endState).toBe("code")
    expect(
      WHOLE.code,
      "The census cost a full anti-join and used to reach nobody but a Vercel " +
        "log line. It belongs in extra, where an observer can read it.",
    ).toContain("uncovered_census: uncoveredCensus,")
  })
})
