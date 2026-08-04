import { describe, it, expect } from "vitest"
import { fmtUsd, fmt, shortAddr, relativeDate, deltaPct, pickEarliest, pickLatest, shortSlug, marketplaceLabel, marketplaceColor } from "@/lib/analytics/format"

// Shared analytics formatters. Pure except relativeDate (Date.now); pin the
// deterministic money/address formatting + relativeDate's invalid-date guard.

describe("fmtUsd", () => {
  it("formats a 2-decimal USD string, nullish → $0.00", () => {
    expect(fmtUsd(1234.5)).toBe("$1,234.50")
    expect(fmtUsd(0)).toBe("$0.00")
    // @ts-expect-error — guarding the runtime Number(x)||0 path
    expect(fmtUsd(null)).toBe("$0.00")
  })
})

describe("fmt (compact money)", () => {
  it("abbreviates millions and thousands", () => {
    expect(fmt(2_500_000)).toBe("$2.5M")
    expect(fmt(1_500)).toBe("$1.5k")
    expect(fmt(42)).toBe("$42.00")
  })
  it("abbreviates NEGATIVE values too (losing-wallet P&L), sign outside the $", () => {
    // regression: negatives used to skip the M/k branches and render
    // "$-1500.00" / "$-2500000.00" instead of the abbreviated, signed form.
    expect(fmt(-2_500_000)).toBe("-$2.5M")
    expect(fmt(-1_500)).toBe("-$1.5k")
    expect(fmt(-42)).toBe("-$42.00")
    expect(fmt(0)).toBe("$0.00")
  })
})

describe("shortAddr", () => {
  it("truncates long addresses, passes short/empty through", () => {
    expect(shortAddr("0xbd94cade097e50ac")).toBe("0xbd94…50ac")
    expect(shortAddr("0x1234")).toBe("0x1234")
    expect(shortAddr("")).toBe("—")
  })
})

describe("relativeDate", () => {
  it("returns '' for an invalid date", () => {
    expect(relativeDate("not-a-date")).toBe("")
  })
  it("returns an ISO day for dates older than 30 days", () => {
    expect(relativeDate("2020-01-15T00:00:00Z")).toBe("2020-01-15")
  })
})

describe("deltaPct — null/zero-safe percentage change (extracted from PulseDashboard)", () => {
  it("computes a one-decimal percentage change", () => {
    expect(deltaPct(150, 100)).toBe(50)
    expect(deltaPct(75, 100)).toBe(-25)
    expect(deltaPct(133, 100)).toBe(33) // rounds 33.0
    expect(deltaPct(1015, 1000)).toBe(1.5)
  })
  it("returns null for nullish or non-finite inputs (renders as —, never a fake delta)", () => {
    expect(deltaPct(null, 100)).toBeNull()
    expect(deltaPct(100, null)).toBeNull()
    expect(deltaPct(undefined, undefined)).toBeNull()
    expect(deltaPct(Infinity, 100)).toBeNull()
    expect(deltaPct(100, NaN)).toBeNull()
  })
  it("returns null for a non-positive baseline (a %-change off 0 is undefined)", () => {
    expect(deltaPct(50, 0)).toBeNull()
    expect(deltaPct(50, -10)).toBeNull()
  })
})

describe("pickEarliest / pickLatest — null-safe ISO extremum (extracted from WalletProfile)", () => {
  const a = "2026-01-01T00:00:00Z"
  const b = "2026-06-15T12:00:00Z"
  const c = "2026-12-31T23:59:59Z"
  it("picks the earliest/latest ignoring nullish entries", () => {
    expect(pickEarliest(b, a, c)).toBe(a)
    expect(pickLatest(b, a, c)).toBe(c)
    expect(pickEarliest(null, b, undefined, a)).toBe(a)
    expect(pickLatest(null, b, undefined, a)).toBe(b)
  })
  it("returns null when no valid timestamp is present", () => {
    expect(pickEarliest()).toBeNull()
    expect(pickEarliest(null, undefined)).toBeNull()
    expect(pickLatest(null, undefined)).toBeNull()
  })
  it("returns the single value when only one is valid", () => {
    expect(pickEarliest(null, b)).toBe(b)
    expect(pickLatest(b, null)).toBe(b)
  })
})

describe("shortSlug", () => {
  it("maps known URL slugs to short DB slugs", () => {
    expect(shortSlug("nba-top-shot")).toBe("topshot")
    expect(shortSlug("nfl-all-day")).toBe("allday")
    expect(shortSlug("laliga-golazos")).toBe("golazos")
    expect(shortSlug("disney-pinnacle")).toBe("pinnacle")
    expect(shortSlug("ufc")).toBe("ufc")
  })
  it("passes an unknown slug through unchanged", () => {
    expect(shortSlug("candy-mlb")).toBe("candy-mlb")
  })
})

describe("marketplaceLabel", () => {
  it("returns the mapped label for known keys", () => {
    expect(marketplaceLabel("topshot")).toBe("TopShot Native")
    expect(marketplaceLabel("flowty")).toBe("Flowty")
    expect(marketplaceLabel("on-chain")).toBe("On-chain")
  })
  it("capitalizes an unknown key as a fallback", () => {
    expect(marketplaceLabel("beezie")).toBe("Beezie")
  })
})

describe("marketplaceColor", () => {
  it("returns the mapped color for known keys", () => {
    expect(marketplaceColor("topshot")).toBe("#E03A2F")
    expect(marketplaceColor("golazos")).toBe("#22C55E")
  })
  it("returns neutral grey for an unknown key", () => {
    expect(marketplaceColor("mystery")).toBe("#6B7280")
  })
})
