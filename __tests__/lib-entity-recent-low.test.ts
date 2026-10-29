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

// 2026-10-27: the edition page's FMV sentence printed fmv.floor_price_usd raw ("with a recent-sale low of $57,000"
// under a $1,700 FMV) after the tiles and the SQL totals stopped showing it. It reads the same bounded value now.
describe("the edition page's FMV sentence uses the bounded recent low", () => {
  const src = readFileSync(`${process.cwd()}/app/(collections)/[collection]/edition/[slug]/page.tsx`, "utf8")
  it("never prints fmv.floor_price_usd as a 'low' directly", () => {
    expect(src).not.toMatch(/low of \{fmtUsd\(fmv\?\.floor_price_usd/)
    expect(src).toMatch(/low of \{fmtUsd\(sentenceRecentLow\)\}/)
    expect(src).toMatch(/const sentenceRecentLow = [^\n]*recentLowUsd\(fmv\?\.floor_price_usd, fmv\?\.fmv_usd\)/)
  })
  // 2026-10-28: floor_price_usd means "lowest recent sale or ask" (#143), and on an ask-derived FMV it IS the ask —
  // Toni Kukoc's Illustrated /4 read "a recent-sale low of $750" with no sale ever. The sentence names an ask an ask
  // and calls the general case a "low" (the tiles' word), never a "sale low".
  it("never calls the floor a SALE low, and names an ask-derived FMV's floor an ask", () => {
    expect(src).not.toMatch(/"sale" : "recent-sale"/)
    expect(src).not.toMatch(/sale"?\}? low of \{fmtUsd\(sentenceRecentLow\)\}/)
    expect(src).toMatch(/const floorIsTheAsk = isAskDerivedFmv\(fmv\?\.confidence\)/)
    expect(src).toMatch(/floorIsTheAsk \? <>, from an ask of \{fmtUsd\(sentenceRecentLow\)\}<\/>/)
  })
})
