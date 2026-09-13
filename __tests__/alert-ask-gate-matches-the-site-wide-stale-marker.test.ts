import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ASK_STALE_HOURS, isAskStale } from "@/lib/market/ask-freshness"

// 🚨 WHY THIS EXISTS (2026-09-13, audit_20260912).
//
// The alert scanners refuse to build an alert from an ask nobody has re-confirmed
// inside a window, and that window is deliberately NOT a new number: it is
// ASK_STALE_HOURS — the same 12 h the deals board, the edition page and the
// Bid-vs-Floor board already use to stamp an ask "unconfirmed 30h". The point of
// reusing it is that an alert and the board it links to cannot disagree about what
// "stale" means: a notification that says "may be gone" while the board it points
// at calls the same ask fresh (or the reverse) is a contradiction a reader can see.
//
// ⚠ BUT THE TWO SPELLINGS LIVE IN DIFFERENT LANGUAGES AND DIFFERENT DEPLOY PATHS.
// The TypeScript constant ships with a Vercel build; the SQL predicate ships with a
// migration. Nothing else in the estate compares them, so one could be changed
// alone — silently, in the direction of sending MORE stale alerts — and every test
// in both trees would stay green. This is the only thing that reds.
//
// ⭐ IT READS THE COMMITTED MIGRATION, NOT THE LIVE DB, on purpose: this is a
// unit test in the blocking job, it must run with no database, and the pin file
// + __tests__/db-invariants-drift-guard.test.ts already tie the migration to the
// live object. Chaining those two is what makes this a real check on production.
const MIGRATION =
  "supabase/migrations/20260913061500_audit_20260912_an_alert_is_never_built_from_an_unconfirmed_ask.sql"

function gateSource(): string {
  const src = readFileSync(path.join(process.cwd(), MIGRATION), "utf8")
  // The function body, not the header prose — the header quotes a rollback
  // recipe that also mentions the function.
  const start = src.indexOf("CREATE OR REPLACE FUNCTION public.ask_is_alertable(\n")
  expect(start, `the gate's declaration is missing from ${MIGRATION}`).toBeGreaterThan(-1)
  const end = src.indexOf("$function$;", start)
  expect(end).toBeGreaterThan(start)
  return src.slice(start, end)
}

describe("the alert freshness gate and the site-wide stale marker are the same threshold", () => {
  it("the migration's window is exactly ASK_STALE_HOURS", () => {
    const body = gateSource()
    const m = /interval\s+'(\d+)\s+hours'/.exec(body)
    expect(m, "no `interval 'N hours'` in the gate — was it rewritten?").not.toBeNull()
    expect(Number(m![1])).toBe(ASK_STALE_HOURS)
  })

  it("states the window ONCE, so there is no second number to drift", () => {
    const hits = gateSource().match(/interval\s+'\d+\s+hours'/g) ?? []
    expect(hits.length).toBe(1)
  })

  it("the two agree on the BOUNDARY, not just the number", () => {
    // isAskStale is `>= ASK_STALE_HOURS`; the SQL is `p_ask_at > now - interval`,
    // i.e. NOT alertable at exactly the threshold. Same edge, opposite phrasing —
    // which is precisely the kind of thing that reads equivalent and is not.
    const now = Date.parse("2026-09-13T06:00:00Z")
    const at = (h: number) => new Date(now - h * 3_600_000).toISOString()
    expect(isAskStale(at(ASK_STALE_HOURS), now)).toBe(true)
    expect(isAskStale(at(ASK_STALE_HOURS - 0.01), now)).toBe(false)
    expect(gateSource()).toContain("p_ask_at > p_now - interval")
    expect(gateSource()).not.toContain("p_ask_at >= p_now - interval")
  })

  it("NULL is not alertable, even though NULL is not 'stale' for the marker", () => {
    // The asymmetry is deliberate and is the single likeliest thing for a future
    // reader to "harmonise". isAskStale(null) is FALSE — unknown must not render
    // as a stale marker — while the gate must treat unknown as NOT SENDABLE.
    expect(isAskStale(null)).toBe(false)
    expect(gateSource()).toContain("p_ask_at IS NOT NULL")
  })

  it("the exempt arms are the event-sourced books, and only those", () => {
    // If a collection is added here, it is a claim that its ask timestamp is a
    // LISTING date over an index a row leaves when the listing closes — not that
    // its lane is inconvenient to keep fresh.
    const body = gateSource()
    const m = /IN \(([^)]*)\) THEN true/.exec(body)
    expect(m, "the exempt list changed shape — re-read the migration header").not.toBeNull()
    const exempt = m![1].split(",").map((x) => x.trim().replace(/'/g, ""))
    expect(exempt.sort()).toEqual(["laliga_golazos", "nfl_all_day"])
  })
})
