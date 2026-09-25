import { describe, it, expect } from "vitest"
import { staleTouchDaysSinceSale } from "@/lib/fmv-stale-touch"

// The age a stale-touch re-stamp carries. Three sources, in order: the true
// last sale; the prior row's age advanced by the days since it was written;
// nothing (null — an unknown age is not 0 and not "30").
const NOW = new Date("2026-09-25T09:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString()

describe("staleTouchDaysSinceSale", () => {
  it("measures from the true last sale when one is named", () => {
    expect(staleTouchDaysSinceSale({ last_sold_at: daysAgo(47), days_since_sale: 30, computed_at: daysAgo(1) }, NOW)).toBe(47)
  })
  it("advances the prior age by the days elapsed since that row was written", () => {
    expect(staleTouchDaysSinceSale({ last_sold_at: null, days_since_sale: 200, computed_at: daysAgo(40) }, NOW)).toBe(240)
  })
  it("never FREEZES: the same prior row read on two later days gives two later ages", () => {
    const prior = { last_sold_at: null, days_since_sale: 30, computed_at: daysAgo(0) }
    const later = new Date(NOW.getTime() + 5 * 86_400_000)
    expect(staleTouchDaysSinceSale(prior, later)).toBe(35)
  })
  it("keeps the prior age as-is when the prior stamp is unreadable", () => {
    expect(staleTouchDaysSinceSale({ days_since_sale: 12, computed_at: "not-a-date" }, NOW)).toBe(12)
  })
  it("is null when nothing can be derived — never a fabricated 0", () => {
    expect(staleTouchDaysSinceSale({ last_sold_at: null, days_since_sale: null, computed_at: daysAgo(3) }, NOW)).toBeNull()
    expect(staleTouchDaysSinceSale({}, NOW)).toBeNull()
  })
  it("clamps a sale dated in the future (clock skew) to 0, not negative", () => {
    expect(staleTouchDaysSinceSale({ last_sold_at: daysAgo(-1) }, NOW)).toBe(0)
  })
})
