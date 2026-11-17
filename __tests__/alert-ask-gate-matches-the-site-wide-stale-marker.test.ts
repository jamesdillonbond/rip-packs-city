import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import path from "node:path"
import { ALERT_TOPSHOT_ASK_MAX_AGE_HOURS, ASK_STALE_HOURS, isAskStale } from "@/lib/market/ask-freshness"

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
// Re-pointed 2026-09-30 to the migration that last defines the gate
// (audit_20260930: Top Shot edition asks get ALERT_TOPSHOT_ASK_MAX_AGE_HOURS).
const MIGRATION =
  "supabase/migrations/20261001030000_audit_20260930_topshot_alert_asks_are_rechecked_before_they_are_sent.sql"

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
  // audit_20260930: TWO windows, each stated exactly once and each tied to its
  // TS constant. The ELSE arm (Pinnacle, the serial board, anything new) is the
  // site-wide ASK_STALE_HOURS; the Top Shot EDITION arm is the alert-only 1 h.
  it("the migration's ELSE window is exactly ASK_STALE_HOURS", () => {
    const m = /ELSE p_ask_at IS NOT NULL AND p_ask_at > p_now - interval\s+'(\d+)\s+hours'/.exec(gateSource())
    expect(m, "no ELSE `interval 'N hours'` in the gate — was it rewritten?").not.toBeNull()
    expect(Number(m![1])).toBe(ASK_STALE_HOURS)
  })

  it("the Top Shot edition window is exactly ALERT_TOPSHOT_ASK_MAX_AGE_HOURS, for BOTH spellings", () => {
    const m = /WHEN p_collection_slug IN \('nba_top_shot', 'nba-top-shot'\) THEN\s+p_ask_at IS NOT NULL AND p_ask_at > p_now - interval\s+'(\d+)\s+hours'/.exec(gateSource())
    expect(m, "the Top Shot arm changed shape — re-read the migration header").not.toBeNull()
    expect(Number(m![1])).toBe(ALERT_TOPSHOT_ASK_MAX_AGE_HOURS)
    expect(ALERT_TOPSHOT_ASK_MAX_AGE_HOURS).toBeLessThan(ASK_STALE_HOURS)
  })

  it("states each window ONCE, so there is no third number to drift", () => {
    const hits = gateSource().match(/interval\s+'\d+\s+hours?'/g) ?? []
    expect(hits.length).toBe(2)
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
