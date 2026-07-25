import { describe, it, expect } from "vitest"
import {
  fmtSoldUsd,
  relativeSaleTime,
  shortSellerAddr,
  filterSoldEventsByCollection,
  sumSoldProceeds,
  isSoldListTruncated,
} from "@/lib/collection-sold-moments-format"

// Pins the pure formatting/filtering/aggregation logic lifted out of
// components/collection/WalletSoldMomentsView.tsx (invisible to the coverage
// ratchet). A regression here mis-labels a sale, leaks another collection's
// sales onto the "Sold" board, or breaks the proceeds tile / truncation banner.

describe("fmtSoldUsd", () => {
  it("returns an em-dash for null/undefined", () => {
    expect(fmtSoldUsd(null)).toBe("—")
    expect(fmtSoldUsd(undefined)).toBe("—")
  })
  it("formats zero with two decimals", () => {
    expect(fmtSoldUsd(0)).toBe("$0.00")
  })
  it("groups thousands and keeps two decimals", () => {
    expect(fmtSoldUsd(1234.5)).toBe("$1,234.50")
    expect(fmtSoldUsd(1000000)).toBe("$1,000,000.00")
  })
  it("rounds to two decimals", () => {
    expect(fmtSoldUsd(3.14159)).toBe("$3.14")
  })
})

describe("relativeSaleTime", () => {
  const now = Date.UTC(2026, 6, 24, 12, 0, 0) // 2026-07-24T12:00:00Z
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString()
  const DAY = 86_400_000

  it("returns em-dash for null iso", () => {
    expect(relativeSaleTime(null, now)).toBe("—")
  })
  it("returns em-dash for an unparseable iso", () => {
    expect(relativeSaleTime("not-a-date", now)).toBe("—")
  })
  it("labels the same day as 'today'", () => {
    expect(relativeSaleTime(iso(0), now)).toBe("today")
    expect(relativeSaleTime(iso(DAY - 1), now)).toBe("today")
  })
  it("labels exactly one day as '1d ago'", () => {
    expect(relativeSaleTime(iso(DAY), now)).toBe("1d ago")
  })
  it("labels 2..29 days as 'Nd ago'", () => {
    expect(relativeSaleTime(iso(2 * DAY), now)).toBe("2d ago")
    expect(relativeSaleTime(iso(29 * DAY), now)).toBe("29d ago")
  })
  it("labels 1..11 months as 'Nmo ago'", () => {
    expect(relativeSaleTime(iso(30 * DAY), now)).toBe("1mo ago")
    expect(relativeSaleTime(iso(11 * 30 * DAY), now)).toBe("11mo ago")
  })
  it("labels a year or more as 'Ny ago'", () => {
    expect(relativeSaleTime(iso(12 * 30 * DAY), now)).toBe("1y ago")
    expect(relativeSaleTime(iso(24 * 30 * DAY), now)).toBe("2y ago")
  })
})

describe("shortSellerAddr", () => {
  it("returns em-dash for null", () => {
    expect(shortSellerAddr(null)).toBe("—")
  })
  it("leaves short strings (<=12 chars) untouched", () => {
    expect(shortSellerAddr("0x1234")).toBe("0x1234")
    expect(shortSellerAddr("0x1234567890")).toBe("0x1234567890") // exactly 12
  })
  it("truncates long addresses to head…tail", () => {
    expect(shortSellerAddr("0x1234567890abcdef")).toBe("0x1234…cdef")
  })
})

describe("filterSoldEventsByCollection", () => {
  const ev = (collection_slug: string | null, id: string) => ({ collection_slug, id })

  it("returns all events unchanged when dbSlug is null", () => {
    const events = [ev("nba_top_shot", "a"), ev("nfl_all_day", "b")]
    expect(filterSoldEventsByCollection(events, null, "nba-top-shot")).toBe(events)
  })
  it("keeps rows matching the db slug", () => {
    const events = [ev("nba_top_shot", "a"), ev("nfl_all_day", "b")]
    const out = filterSoldEventsByCollection(events, "nba_top_shot", "nba-top-shot")
    expect(out.map((e) => e.id)).toEqual(["a"])
  })
  it("also accepts the raw route-prop identifier form", () => {
    const events = [ev("nba-top-shot", "a"), ev("nfl_all_day", "b")]
    const out = filterSoldEventsByCollection(events, "nba_top_shot", "nba-top-shot")
    expect(out.map((e) => e.id)).toEqual(["a"])
  })
  it("trims whitespace on the event slug before matching", () => {
    const events = [ev("  nba_top_shot  ", "a")]
    const out = filterSoldEventsByCollection(events, "nba_top_shot", "nba-top-shot")
    expect(out.map((e) => e.id)).toEqual(["a"])
  })
  it("treats a null event slug as an empty string (no match)", () => {
    const events = [ev(null, "a"), ev("nba_top_shot", "b")]
    const out = filterSoldEventsByCollection(events, "nba_top_shot", "nba-top-shot")
    expect(out.map((e) => e.id)).toEqual(["b"])
  })
})

describe("sumSoldProceeds", () => {
  it("sums amount_usd across rows", () => {
    expect(sumSoldProceeds([{ amount_usd: 10 }, { amount_usd: 5.5 }])).toBe(15.5)
  })
  it("treats null/NaN amounts as zero", () => {
    expect(sumSoldProceeds([{ amount_usd: null }, { amount_usd: 7 }])).toBe(7)
    expect(sumSoldProceeds([{ amount_usd: Number.NaN }, { amount_usd: 3 }])).toBe(3)
  })
  it("returns 0 for an empty list", () => {
    expect(sumSoldProceeds([])).toBe(0)
  })
})

describe("isSoldListTruncated", () => {
  it("false when total count is null/undefined", () => {
    expect(isSoldListTruncated(null, 200)).toBe(false)
    expect(isSoldListTruncated(undefined, 200)).toBe(false)
  })
  it("false when total count is at or below the page limit", () => {
    expect(isSoldListTruncated(200, 200)).toBe(false)
    expect(isSoldListTruncated(5, 200)).toBe(false)
  })
  it("true when total count exceeds the page limit", () => {
    expect(isSoldListTruncated(201, 200)).toBe(true)
  })
})
