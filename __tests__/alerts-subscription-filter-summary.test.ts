import { describe, it, expect } from "vitest"
import { subscriptionFilterSummary } from "@/lib/alerts/form"

// `/alerts` is the screen a collector opens to check what they actually asked
// for, and its saved-subscription line used to be a bare `≥${min_discount}% off`.
// Since audit_20260816 a subscription with a max_price and min_discount 0 has NO
// FMV condition — the scanner serves it from `edition_current_ask` rather than
// the deals board — so 0 is a sentinel, not a weak threshold. Rendering it as
// "≥0% off" both reads like a bug and omits the ONLY condition the alert has.
describe("subscriptionFilterSummary", () => {
  it("describes a price-only alert by its price, and says FMV is ignored", () => {
    const s = subscriptionFilterSummary({ min_discount: 0, max_price: 0.6 })
    expect(s).toBe("price ≤$0.60 · FMV ignored")
    expect(s).not.toContain("%")
  })

  it("includes a floor when the price-only alert has one", () => {
    expect(subscriptionFilterSummary({ min_discount: 0, max_price: 5, min_price: 1 })).toBe(
      "price $1.00–$5.00 · FMV ignored"
    )
  })

  // ⚠ BOTH DIRECTIONS. An ordinary discount alert must keep leading with its
  // discount — a fix that described every alert by price would strip the single
  // most useful term from every existing subscription.
  it("an ordinary discount alert still leads with the discount", () => {
    expect(subscriptionFilterSummary({ min_discount: 25, max_price: null })).toBe("≥25% off")
    expect(subscriptionFilterSummary({ min_discount: 30, max_price: 200 })).toBe("≥30% off · ≤$200.00")
  })

  // ⚠ min_discount 0 WITHOUT a max_price is NOT price-only — it is "any discount
  // at all", which the deals board still answers. Mirrors the scanner predicate
  // exactly; if this drifts, the screen describes a different alert than the one
  // that runs.
  it("min_discount 0 with no max_price is not price-only", () => {
    expect(subscriptionFilterSummary({ min_discount: 0, max_price: null })).toBe("≥0% off")
  })

  it("a null min_discount reads as the 25 default the scanner applies", () => {
    expect(subscriptionFilterSummary({ min_discount: null, max_price: 0.6 })).toBe("≥25% off · ≤$0.60")
  })

  // 2026-11-13: a saved serial range must be visible on the line that describes
  // the alert. A collector's "serial 111" alerts misfired, the line showed only
  // "≥25% off", and nothing on /alerts said the range had been saved at all.
  it("shows a saved serial condition", () => {
    expect(subscriptionFilterSummary({ min_discount: 25, min_serial: 111, max_serial: 111 })).toBe("≥25% off · serial #111")
    expect(subscriptionFilterSummary({ min_discount: 25, min_serial: 1, max_serial: 99 })).toBe("≥25% off · serial #1–#99")
    expect(subscriptionFilterSummary({ min_discount: 25, min_serial: 500 })).toBe("≥25% off · serial ≥#500")
    expect(subscriptionFilterSummary({ min_discount: 0, max_price: 5, max_serial: 10, require_last_mint: true })).toBe(
      "price ≤$5.00 · FMV ignored · serial ≤#10 · last mint"
    )
    expect(subscriptionFilterSummary({ min_discount: 25, require_jersey_serial: true })).toBe("≥25% off · jersey serial")
  })

  it("adds nothing when no serial condition is set (control)", () => {
    expect(subscriptionFilterSummary({ min_discount: 25, min_serial: null, max_serial: null, require_last_mint: false })).toBe("≥25% off")
  })
})
