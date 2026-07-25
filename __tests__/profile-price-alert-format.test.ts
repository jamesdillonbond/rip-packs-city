import { describe, it, expect } from "vitest"
import { describeAlert, formatAlertWhen } from "@/lib/profile-price-alert-format"

// Pins the pure alert-description and last-triggered-label logic lifted out of
// components/profile/PriceAlertsCard.tsx (invisible to the coverage ratchet). A
// regression here mis-describes an alert's trigger condition or mis-labels when
// it last fired. fmtDollars is imported by the module under test, so these also
// exercise its threshold branch (>= 1000 → $XK).

describe("describeAlert", () => {
  it("describes a below_price alert with a dollar threshold", () => {
    expect(describeAlert("below_price", 12.5)).toBe("Lowest ask drops to or below $12.50")
  })
  it("uses the $XK form for large dollar thresholds", () => {
    expect(describeAlert("below_price", 2500)).toBe("Lowest ask drops to or below $2.5K")
  })
  it("describes a below_fmv_pct alert as a percentage", () => {
    expect(describeAlert("below_fmv_pct", 15)).toBe("Discount vs FMV exceeds 15%")
  })
  it("describes a below_fmv alert with a dollar threshold", () => {
    expect(describeAlert("below_fmv", 40)).toBe("FMV drops below $40.00")
  })
  it("describes an above_fmv alert with a dollar threshold", () => {
    expect(describeAlert("above_fmv", 99.99)).toBe("FMV rises above $99.99")
  })
  it("falls back to '<type> ≥ <threshold>' for an unknown alert type", () => {
    expect(describeAlert("mystery", 7)).toBe("mystery ≥ 7")
  })
})

describe("formatAlertWhen", () => {
  const now = Date.UTC(2026, 6, 24, 12, 0, 0)
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
  const DAY = 24 * 60 * 60 * 1000

  it("returns 'Never' for a null timestamp", () => {
    expect(formatAlertWhen(null, now)).toBe("Never")
  })
  it("returns 'Today' within the last day", () => {
    expect(formatAlertWhen(iso(0), now)).toBe("Today")
    expect(formatAlertWhen(iso(DAY - 1), now)).toBe("Today")
  })
  it("returns 'Yesterday' within the second day", () => {
    expect(formatAlertWhen(iso(DAY), now)).toBe("Yesterday")
    expect(formatAlertWhen(iso(2 * DAY - 1), now)).toBe("Yesterday")
  })
  it("returns 'Nd ago' from 2 up to 6 days", () => {
    expect(formatAlertWhen(iso(2 * DAY), now)).toBe("2d ago")
    expect(formatAlertWhen(iso(6 * DAY), now)).toBe("6d ago")
  })
  it("returns an absolute date string for 7+ days", () => {
    const out = formatAlertWhen(iso(30 * DAY), now)
    expect(typeof out).toBe("string")
    expect(out.length).toBeGreaterThan(0)
    // Not one of the relative labels
    expect(["Never", "Today", "Yesterday"]).not.toContain(out)
    expect(out).not.toMatch(/d ago$/)
  })
})
