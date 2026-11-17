// R103 (2026-10-03): Top Shot pricing dates an ask by when it was last SEEN
// (edition_offers.low_ask_confirmed_at), not by when its price last CHANGED
// (edition_offers.updated_at). Measured that day: 4,868 of 13,657 Top Shot asks
// (35.6%) were past MAX_ASK_AGE_HOURS_CORROBORATION by updated_at, 2,575 (18.9%)
// by the later of the two — so about 2,300 live asks had been barred from
// corroborating a price only because their price had not moved.
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { askAgeHours, topShotAskObservedAt } from "@/lib/market/ask-freshness"
import { escalateConfidence, MAX_ASK_AGE_HOURS_CORROBORATION } from "@/lib/fmv-confidence"

const NOW = Date.parse("2026-10-03T17:00:00Z")
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()

describe("topShotAskObservedAt", () => {
  it("prefers the re-observation stamp when the price has not moved for 10 days", () => {
    const at = topShotAskObservedAt({ updated_at: hoursAgo(240), low_ask_confirmed_at: hoursAgo(1) })
    expect(askAgeHours(at, NOW)).toBeCloseTo(1, 5)
  })

  it("takes the later stamp in either order (a price change sets updated_at too)", () => {
    const at = topShotAskObservedAt({ updated_at: hoursAgo(2), low_ask_confirmed_at: hoursAgo(50) })
    expect(askAgeHours(at, NOW)).toBeCloseTo(2, 5)
  })

  it("falls back to updated_at when the confirm stamp is missing or unparseable", () => {
    expect(askAgeHours(topShotAskObservedAt({ updated_at: hoursAgo(30), low_ask_confirmed_at: null }), NOW)).toBeCloseTo(30, 5)
    expect(askAgeHours(topShotAskObservedAt({ updated_at: hoursAgo(30) }), NOW)).toBeCloseTo(30, 5)
    expect(askAgeHours(topShotAskObservedAt({ updated_at: hoursAgo(30), low_ask_confirmed_at: "not a date" }), NOW)).toBeCloseTo(30, 5)
  })

  it("returns null — never now — when neither stamp parses", () => {
    expect(topShotAskObservedAt({})).toBeNull()
    expect(topShotAskObservedAt({ updated_at: null, low_ask_confirmed_at: null })).toBeNull()
    expect(topShotAskObservedAt({ updated_at: "garbage", low_ask_confirmed_at: "" })).toBeNull()
  })

  it("leaves a genuinely unseen ask past the bound (the gate still bites)", () => {
    const at = topShotAskObservedAt({ updated_at: hoursAgo(400), low_ask_confirmed_at: hoursAgo(200) })
    expect(askAgeHours(at, NOW)!).toBeGreaterThanOrEqual(MAX_ASK_AGE_HOURS_CORROBORATION)
  })
})

describe("the corroboration gate reads the last-seen age end to end", () => {
  // Same edition, same sales, same ask; only the stamp the age is read from differs.
  const TIGHT = [100, 100, 100, 100]
  const stale = askAgeHours(hoursAgo(240), NOW)
  const seen = askAgeHours(topShotAskObservedAt({ updated_at: hoursAgo(240), low_ask_confirmed_at: hoursAgo(1) }), NOW)

  it("is not vacuous: a 10-day change-stamp alone withholds the lift", () => {
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, stale)).toBe("LOW")
  })

  it("the last-seen stamp lets the same live ask corroborate", () => {
    expect(escalateConfidence("LOW", 4, TIGHT, undefined, 100, seen)).toBe("MEDIUM")
  })
})

describe("fmv-recalc wires the helper", () => {
  const src = readFileSync(path.join(path.resolve(__dirname, ".."), "app/api/fmv-recalc/route.ts"), "utf8")
  it("dates the Top Shot ask with topShotAskObservedAt, not updated_at alone", () => {
    expect(src).toContain("const rawAskAt = topShotAskObservedAt(row as any)")
    expect(src).not.toMatch(/const rawAskAt = \(row as any\)\.updated_at/)
  })
})
