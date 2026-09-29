// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The /market hub page (2026-09-28) — the bottom bar's MARKET tab. The tile-stat
// rules live in lib/market/hub.ts (__tests__/market-hub-data.test.ts); pinned
// here is how the page renders them: a zero WITH its date, no number on a failed
// pulse, top sales' three states, and collection-scoped edition links.

// ── the page ────────────────────────────────────────────────────────────────

const state = {
  tile: { pulseOk: true, stats: new Map<string, unknown>() },
  sales: { ok: true as boolean, rows: [] as unknown[] },
}
vi.mock("@/lib/market/hub", () => ({ fetchMarketTileStats: async () => state.tile }))
vi.mock("@/lib/insights/top-sales", () => ({
  fetchTopSales: async () => {
    if (!state.sales.ok) throw new Error("boom")
    return { rows: state.sales.rows, fetchedAt: "x" }
  },
}))
vi.mock("@/lib/insights/board-page-fetch", () => ({ withBoardBudget: (p: Promise<unknown>) => p }))
vi.mock("@/components/GlobalSiteHeader", () => ({ default: () => <header data-testid="site-header" /> }))
vi.mock("@/components/SiteFooter", () => ({ default: () => <footer /> }))
vi.mock("@/components/hub/LastCollectionShortcut", () => ({ default: () => null }))
vi.mock("next/link", () => ({
  default: ({ children, href, ...p }: { children?: React.ReactNode; href: string } & Record<string, unknown>) => (
    <a href={href} {...(p as object)}>{children}</a>
  ),
}))

async function renderHub() {
  const { default: MarketHubPage } = await import("@/app/market/page")
  return render(await MarketHubPage())
}

afterEach(() => {
  cleanup()
  state.tile = { pulseOk: true, stats: new Map() }
  state.sales = { ok: true, rows: [] }
})

describe("market hub page", () => {
  it("renders a tile per collection with a market, linking to it — and none for UFC", async () => {
    const { container, queryByTestId } = await renderHub()
    expect(queryByTestId("market-tile-nba-top-shot")?.getAttribute("href")).toBe("/nba-top-shot/market")
    expect(queryByTestId("market-tile-ufc")).toBeNull()
    expect(container.textContent).not.toMatch(/\$0\b/)
  })

  it("renders a zero as 'no sales recorded' WITH its last-sale date", async () => {
    state.tile = {
      pulseOk: true,
      stats: new Map([["laliga-golazos", { sales24h: 0, volume24h: null, topSale24h: null, lastSaleAt: "2026-09-12T22:24:33Z" }]]),
    }
    const { getByTestId } = await renderHub()
    expect(getByTestId("market-tile-zero-laliga-golazos").textContent).toBe("No sales recorded in 24h · last Sep 12")
  })

  it("⛔ a failed pulse says so and prints no number on any tile", async () => {
    state.tile = { pulseOk: false, stats: new Map() }
    const { queryByTestId, container } = await renderHub()
    expect(queryByTestId("market-hub-pulse-unavailable")).not.toBeNull()
    expect(container.querySelector('[data-testid^="market-tile-zero"]')).toBeNull()
    expect(container.textContent).not.toMatch(/\d+ sales/)
  })

  it("⛔ failed top sales says unavailable, never 'no sales'", async () => {
    state.sales = { ok: false, rows: [] }
    const { queryByTestId } = await renderHub()
    expect(queryByTestId("market-hub-sales-unavailable")).not.toBeNull()
    expect(queryByTestId("market-hub-sales-empty")).toBeNull()
  })

  it("links a top sale to its collection-scoped edition page", async () => {
    state.sales = {
      ok: true,
      rows: [
        { sale_id: "s1", collection: "nba_top_shot", external_id: "219:7641", player_name: "A", price_usd: 3666, sold_at: "2026-09-28T20:00:00Z", nft_id: "123" },
        { sale_id: "s2", collection: null, external_id: "x", player_name: "B", price_usd: 10, sold_at: null, nft_id: "9" },
      ],
    }
    const { getByTestId } = await renderHub()
    const list = getByTestId("market-hub-sales")
    expect(Array.from(list.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["/nba-top-shot/edition/219%3A7641"])
    expect(list.querySelectorAll("li").length).toBe(2)
  })

  it("is reachable signed-out", async () => {
    const { isPublicPath } = await import("@/proxy")
    expect(isPublicPath("/market", "GET")).toBe(true)
  })
})
