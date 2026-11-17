import { describe, it, expect } from "vitest"
import {
  bidAgeDays, fmtBidAge, isBidStale, bidAgeTitle,
  BID_STALE_DAYS, BID_AGE_UNKNOWN_LABEL,
} from "@/lib/market/bid-age"

// The property under test is the honesty one: a bid we cannot date must never
// render as a fresh bid. Every "missing" case asserts null — the ABSENCE of an
// age — rather than the presence of some particular string.

const DAY = 86_400_000
const NOW = Date.parse("2026-09-14T12:00:00.000Z")
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()

describe("a bid that cannot be dated is never dated", () => {
  const unageable: Array<[string, string | null | undefined]> = [
    ["null (no matching on-chain offer)", null],
    ["undefined (column absent from the row)", undefined],
    ["empty string", ""],
    ["unparseable text", "not-a-timestamp"],
  ]
  for (const [name, input] of unageable) {
    it(`${name} -> null, not 0`, () => {
      const d = bidAgeDays(input, NOW)
      expect(d).toBeNull()
      // 0 would render as "today" — the exact false claim this guards.
      expect(d).not.toBe(0)
      expect(isBidStale(input, NOW)).toBe(false)
    })
  }

  it("a future stamp is unageable, not a negative age", () => {
    // A clock or ingest fault must not surface as "-3d" or as "today".
    expect(bidAgeDays(ago(-3), NOW)).toBeNull()
  })

  it("has a label for the unknown case, so the cell is never left blank", () => {
    // A blank cell reads as "none"; an explicit word does not.
    expect(BID_AGE_UNKNOWN_LABEL.trim().length).toBeGreaterThan(0)
  })
})

describe("ages that are known", () => {
  it("counts whole days from the block timestamp", () => {
    expect(bidAgeDays(ago(0), NOW)).toBe(0)
    expect(bidAgeDays(ago(1), NOW)).toBe(1)
    expect(bidAgeDays(ago(12.8), NOW)).toBe(12) // the measured median
    expect(bidAgeDays(ago(58), NOW)).toBe(58)   // the measured p90
  })

  it("formats compactly and without inventing precision", () => {
    expect(fmtBidAge(0)).toBe("today")
    expect(fmtBidAge(1)).toBe("1d")
    expect(fmtBidAge(13)).toBe("13d")
    expect(fmtBidAge(14)).toBe("2w")
    expect(fmtBidAge(58)).toBe("8w")
    expect(fmtBidAge(90)).toBe("3mo")
  })

  it("flags staleness only past the threshold, which sits above the median", () => {
    expect(BID_STALE_DAYS).toBeGreaterThan(12.8)
    expect(isBidStale(ago(BID_STALE_DAYS - 1), NOW)).toBe(false)
    expect(isBidStale(ago(BID_STALE_DAYS), NOW)).toBe(true)
  })

  it("reports the age without concluding the bid is dead", () => {
    const t = bidAgeTitle(58)
    expect(t).toMatch(/58 days/)
    expect(t).toMatch(/still open/i)
    // It must not tell the reader the bid failed or will not fill.
    expect(t).not.toMatch(/\b(dead|expired|withdrawn|will not fill\b(?!.))/i)
  })
})
