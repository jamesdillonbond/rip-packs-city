import { describe, it, expect } from "vitest"
import { readdirSync, statSync, readFileSync } from "node:fs"
import { join } from "node:path"

// Source-level guard for a crash-on-malformed-input class fixed on 2026-08-01.
//
// The public `/api/public/insights/*` routes are ANON-reachable and each reads a
// paging bound from the query string. The shape they all shared —
//
//     const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "50")));
//
// looks guarded but is NOT: `?? "50"` only supplies a default when the param is
// ABSENT (null). When it is PRESENT but non-numeric — `?limit=abc` —
// `sp.get("limit")` returns "abc", the `??` passes it through, `Number("abc")` is
// NaN, `Math.min(200, NaN)` is NaN, `Math.max(1, NaN)` is NaN, and that NaN flows
// into `q.limit(NaN)` → PostgREST 400 → supabase-js error → the route 500s
// instead of degrading to the default. `market/route.ts` was a worse variant:
// `days = NaN` → `new Date(Date.now() - NaN).toISOString()` throws a RangeError
// before the DB is even touched. This is the exact class already fixed once in
// `/api/recent-sales` (see CLAUDE.md: "`.limit(NaN)`→PostgREST 400→500").
//
// The fixed idiom coerces NaN back to the default with `|| N` (NaN is falsy):
//
//     const limit = Math.max(1, Math.min(200, Number(sp.get("limit")) || 50));
//
// so absent → Number(null)=0 → `0 || 50` = 50, "abc" → NaN → `NaN || 50` = 50,
// "25" → 25. This mirrors the already-correct pattern in
// `app/api/public/special-serial-owners/route.ts`.
//
// SCOPE: limit / days / offset only — bounds where 0 is never a legitimate value,
// so `|| default` is unambiguously correct. OPTIONAL FILTER params in these
// routes (`min_ask`, `max_mint`, `min_premium`, `min_discount`, `series`, …)
// share the same NaN-to-PostgREST exposure but need a DIFFERENT fix (skip the
// filter or 400 on NaN, since 0 can be a valid filter value), so they are
// deliberately NOT matched here and remain a separate follow-up.
//
// Directory-driven, so a NEW insights route added later is covered automatically.

const INSIGHTS_DIR = join(process.cwd(), "app", "api", "public", "insights")

function insightsRoutes(): { rel: string; src: string }[] {
  return readdirSync(INSIGHTS_DIR)
    .map((d) => ({ dir: d, path: join(INSIGHTS_DIR, d, "route.ts") }))
    .filter(({ path }) => {
      try {
        return statSync(path).isFile()
      } catch {
        return false
      }
    })
    .map(({ dir, path }) => ({
      rel: `app/api/public/insights/${dir}/route.ts`,
      src: readFileSync(path, "utf8"),
    }))
}

// The vulnerable form: a paging bound read as Number(sp.get("KEY") ?? "N"),
// where the `??` default does NOT catch a present-but-non-numeric value.
const VULNERABLE = /Number\(\s*sp\.get\(\s*["'](?:limit|days|offset)["']\s*\)\s*\?\?/

describe("public /insights routes — a non-numeric ?limit/?days must not 500", () => {
  it("is wired to the real insights route files (guard cannot silently detach)", () => {
    const rels = insightsRoutes().map((f) => f.rel)
    for (const expected of [
      "app/api/public/insights/top-sales/route.ts",
      "app/api/public/insights/market/route.ts",
      "app/api/public/insights/deals/route.ts",
    ]) {
      expect(rels).toContain(expected)
    }
    // Sanity: this family is large; a near-empty scan means the glob broke.
    expect(rels.length).toBeGreaterThanOrEqual(15)
  })

  it("no insights route reads a limit/days/offset bound with the NaN-unguarded `?? default` form", () => {
    const offenders: string[] = []
    for (const { rel, src } of insightsRoutes()) {
      src.split("\n").forEach((line, i) => {
        if (VULNERABLE.test(line)) offenders.push(`${rel}:${i + 1}`)
      })
    }
    expect(
      offenders,
      "`Number(sp.get(\"limit\") ?? \"N\")` 500s on `?limit=abc` (the `??` default " +
        "only catches an ABSENT param, not a present non-numeric one; the NaN " +
        "propagates into `.limit(NaN)` → PostgREST 400, or `new Date(NaN)` throws). " +
        "Use the NaN-safe `Number(sp.get(\"limit\")) || N` instead. Offenders:\n" +
        offenders.join("\n"),
    ).toEqual([])
  })
})
