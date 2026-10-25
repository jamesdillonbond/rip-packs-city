import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync } from "node:fs"
import { recentLowUsd, RECENT_LOW_MAX_FMV_MULTIPLE } from "@/lib/entity/recent-low"

// The TS mirror of public.recent_low_usd (20261025221903). The header totals use the SQL one and
// the tiles this one; if the two bounds drift, a set's total and its tiles disagree again.
describe("recentLowUsd", () => {
  it("keeps a floor at or under 3x FMV, drops one above it", () => {
    expect(recentLowUsd(40, 50)).toBe(40)
    expect(recentLowUsd(150, 50)).toBe(150)
    expect(recentLowUsd(57000, 1700)).toBeNull()
  })
  it("keeps the floor when FMV is unknown; no floor is null", () => {
    expect(recentLowUsd(40, null)).toBe(40)
    expect(recentLowUsd(40, 0)).toBe(40)
    expect(recentLowUsd(0, 50)).toBeNull()
    expect(recentLowUsd(null, 50)).toBeNull()
    expect(recentLowUsd(Number.NaN, 50)).toBeNull()
  })
  it("uses the same multiple as the SQL helper", () => {
    const f = readdirSync("supabase/migrations").filter((n) =>
      readFileSync(`supabase/migrations/${n}`, "utf8").includes("CREATE OR REPLACE FUNCTION public.recent_low_usd("),
    )
    expect(f).toHaveLength(1)
    const sql = readFileSync(`supabase/migrations/${f[0]}`, "utf8")
    const m = sql.match(/p_floor <= (\d+) \* p_fmv/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(RECENT_LOW_MAX_FMV_MULTIPLE)
  })
})
