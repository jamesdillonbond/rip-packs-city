import { describe, it, expect } from "vitest"
import {
  CLOSED_MARKETS,
  isMarketClosed,
  closedMarket,
  formatClosedOn,
  closedPriceAsOf,
} from "@/lib/market-closed"

// lib/market-closed.ts is the honesty gate that keeps a dead market's last
// observed price from being published as a CURRENT one (the UFC-Strike case:
// the FMV pipeline keeps re-stamping computed_at so freshness reads green on
// year-old evidence). It is a pure, synchronous module consumed by lib/seo.ts
// on paths with no DB access, so a regression here silently mislabels a dead
// price as live on every SEO title / JSON-LD Offer. These pin the contract.

describe("market-closed — CLOSED_MARKETS registry", () => {
  it("registers UFC under BOTH the canonical slug and its alias (same record)", () => {
    // getCollectionByUrlSlug resolves 'ufc' and 'ufc-strike'; if only one slug
    // were keyed, alias URLs would render a real page and skip the disclosure.
    expect(CLOSED_MARKETS.ufc).toBeDefined()
    expect(CLOSED_MARKETS["ufc-strike"]).toBeDefined()
    expect(CLOSED_MARKETS["ufc-strike"]).toBe(CLOSED_MARKETS.ufc)
  })

  it("the UFC record carries an ISO closure date, a venue, and a plain-words note", () => {
    const ufc = CLOSED_MARKETS.ufc
    expect(ufc.closedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(ufc.closedOn).toBe("2026-05-13")
    expect(ufc.venue).toBe("Flow")
    expect(ufc.note.length).toBeGreaterThan(0)
    // The note must not leak a confidence/tier enum onto a public surface.
    expect(ufc.note).not.toMatch(/\b(HIGH|MEDIUM|LOW|ASK_ONLY|SALES_ONLY|STALE|NO_DATA)\b/)
  })
})

describe("market-closed — isMarketClosed", () => {
  it("is true for a closed slug and its alias, false for live collections", () => {
    expect(isMarketClosed("ufc")).toBe(true)
    expect(isMarketClosed("ufc-strike")).toBe(true)
    expect(isMarketClosed("nba-top-shot")).toBe(false)
    expect(isMarketClosed("nfl-all-day")).toBe(false)
    expect(isMarketClosed("disney-pinnacle")).toBe(false)
  })

  it("is false (never throws) for null / undefined / empty input", () => {
    expect(isMarketClosed(null)).toBe(false)
    expect(isMarketClosed(undefined)).toBe(false)
    expect(isMarketClosed("")).toBe(false)
  })

  it("does not treat an inherited Object.prototype key as a closed market", () => {
    // `slug in CLOSED_MARKETS` would be true for 'toString'/'constructor' if the
    // guard walked the prototype chain; it must only match own registry keys.
    expect(isMarketClosed("toString")).toBe(false)
    expect(isMarketClosed("constructor")).toBe(false)
    expect(isMarketClosed("hasOwnProperty")).toBe(false)
  })
})

describe("market-closed — closedMarket", () => {
  it("returns the record for a closed slug and null for a live one", () => {
    expect(closedMarket("ufc")).toEqual(CLOSED_MARKETS.ufc)
    expect(closedMarket("ufc-strike")).toBe(CLOSED_MARKETS.ufc)
    expect(closedMarket("nba-top-shot")).toBeNull()
  })

  it("returns null for null / undefined / unknown input", () => {
    expect(closedMarket(null)).toBeNull()
    expect(closedMarket(undefined)).toBeNull()
    expect(closedMarket("no-such-collection")).toBeNull()
  })
})

describe("market-closed — formatClosedOn", () => {
  it("renders an ISO date as a stable, locale-independent phrase", () => {
    expect(formatClosedOn("2026-05-13")).toBe("13 May 2026")
    expect(formatClosedOn("2026-01-01")).toBe("1 January 2026")
    expect(formatClosedOn("2026-12-31")).toBe("31 December 2026")
    // Day is un-padded (1, not 01) but the year is verbatim.
    expect(formatClosedOn("2026-09-05")).toBe("5 September 2026")
  })

  it("returns the input verbatim when it is not a YYYY-MM-DD string", () => {
    expect(formatClosedOn("not-a-date")).toBe("not-a-date")
    expect(formatClosedOn("2026/05/13")).toBe("2026/05/13")
    expect(formatClosedOn("")).toBe("")
  })

  it("returns the input verbatim for an out-of-range month (no bogus month name)", () => {
    // month 00 and 13 have no MONTHS entry -> must fall through, not render 'undefined'.
    expect(formatClosedOn("2026-00-10")).toBe("2026-00-10")
    expect(formatClosedOn("2026-13-10")).toBe("2026-13-10")
  })
})

describe("market-closed — closedPriceAsOf", () => {
  it("returns an 'as of <date>' marker for a closed market", () => {
    expect(closedPriceAsOf("ufc")).toBe("as of 13 May 2026")
    expect(closedPriceAsOf("ufc-strike")).toBe("as of 13 May 2026")
  })

  it("returns null for a live market or empty input so callers can skip the marker", () => {
    expect(closedPriceAsOf("nba-top-shot")).toBeNull()
    expect(closedPriceAsOf(null)).toBeNull()
    expect(closedPriceAsOf(undefined)).toBeNull()
  })
})
