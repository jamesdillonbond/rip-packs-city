// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The RPC Index for NFL All Day (2026-10-28): the shared MarketIndexClient with collection="nfl-all-day" plots All
// Day's own tiers (Legendary / Rare / Uncommon / Common — no Fandom, no Ultimate), names All Day, computes every
// number it quotes from the rows, and on a failed read claims nothing about how often Ultimate traded.

import MarketIndexClient, { type Row } from "@/app/insights/market/MarketIndexClient"

function daily(d: string, tier: string, median: number, sales: number): Row {
  return { d, tier, sales, volume_usd: median * sales, median_px: median, avg_px: median, max_px: median * 2 }
}

const rows: Row[] = [
  daily("2026-07-01", "ALL", 0.2, 100),
  daily("2026-07-01", "COMMON", 0.2, 75),
  daily("2026-07-01", "UNCOMMON", 0.25, 15),
  daily("2026-07-01", "RARE", 1.5, 9),
  daily("2026-07-01", "LEGENDARY", 25, 1),
  daily("2026-07-31", "ALL", 0.2, 100),
  daily("2026-07-31", "COMMON", 0.2, 75),
  daily("2026-07-31", "UNCOMMON", 0.3, 14),
  daily("2026-07-31", "RARE", 1.8, 9),
  daily("2026-07-31", "LEGENDARY", 30, 1),
  daily("2026-07-31", "ULTIMATE", 534, 1),
  // A FANDOM row (a Top Shot tier) must not be plotted on All Day even if one appeared.
  daily("2026-07-31", "FANDOM", 9, 1),
]

afterEach(() => cleanup())

describe("MarketIndexClient — NFL All Day", () => {
  it("plots All Day's tiers: Uncommon in, Fandom and Ultimate out", () => {
    const { container } = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" collection="nfl-all-day" />)
    const legend = [...container.querySelectorAll(".rpc-mk-legend-btn")].map((b) => b.textContent?.trim())
    expect(legend).toEqual(["LEGENDARY", "RARE", "UNCOMMON", "COMMON"])
    const cards = [...container.querySelectorAll(".rpc-mk-card-tier")].map((c) => c.textContent?.trim())
    expect(cards).toContain("UNCOMMON")
    expect(cards).not.toContain("FANDOM")
    expect(cards).not.toContain("ULTIMATE")
  })

  it("names NFL All Day and computes the Commons share from the rows (150 of 200 sales → 75%)", () => {
    const { container } = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" collection="nfl-all-day" />)
    const text = container.textContent ?? ""
    expect(text).toContain("The RPC Index · NFL All Day")
    expect(text).toContain("75% of the sales in this window")
    // The lede describes All Day only (the cross-link to the Top Shot index is the one place Top Shot is named).
    expect(container.querySelector(".rpc-mk-lede")?.textContent ?? "").not.toMatch(/Top Shot/)
    expect(text).not.toMatch(/450 of every 550/)
  })

  it("says how many times Ultimate traded, from the rows", () => {
    const { container } = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" collection="nfl-all-day" />)
    expect(container.textContent).toContain("it traded 1 time in this window, too few for an index")
  })

  it("on a failed read claims no Ultimate count and no Commons share", () => {
    const { container } = render(<MarketIndexClient initialRows={[]} initialFetchedAt={null} loadError="boom" collection="nfl-all-day" />)
    const text = container.textContent ?? ""
    expect(text).toContain("temporarily unavailable")
    expect(text).not.toMatch(/traded 0 times/)
    expect(text).toContain("trades too rarely for an index")
    expect(text).not.toMatch(/% of the sales in this window/)
  })

  it("each index links the other collection's page", () => {
    const ad = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" collection="nfl-all-day" />)
    expect(ad.getByTestId("mk-other-index").getAttribute("href")).toBe("/insights/market")
    cleanup()
    const ts = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" />)
    expect(ts.getByTestId("mk-other-index").getAttribute("href")).toBe("/insights/allday-market")
  })

  it("the share link points at All Day's own board", () => {
    const { container } = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" collection="nfl-all-day" />)
    const href = container.querySelector(".rpc-mk-share-btn")?.getAttribute("href") ?? ""
    expect(decodeURIComponent(href)).toContain("/insights/allday-market")
  })

  it("Top Shot (the default) is unchanged: Fandom plotted, no Uncommon", () => {
    const { container } = render(<MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" />)
    const legend = [...container.querySelectorAll(".rpc-mk-legend-btn")].map((b) => b.textContent?.trim())
    expect(legend).toEqual(["LEGENDARY", "RARE", "FANDOM", "COMMON", "ULTIMATE"])
    expect(decodeURIComponent(container.querySelector(".rpc-mk-share-btn")?.getAttribute("href") ?? "")).toMatch(/\/insights\/market(?!-)/)
  })
})
