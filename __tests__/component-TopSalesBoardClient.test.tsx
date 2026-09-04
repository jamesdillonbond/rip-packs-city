// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// TopSalesBoardClient is the whole public /insights/top-sales surface (~1,046
// lines) — a $100+ sales leaderboard across Top Shot + All Day, ranked by price,
// naming buyer/seller. It had ZERO render coverage and lives under app/, which
// NEITHER coverage gate measured until app/insights/**/*Client.tsx was added to
// the component gate. These tests drive its OWN code: the SaleRow render loop and
// the price/int/rel-time/tier helpers over populated + null rows, the empty
// state, and the filter/sort controls that trigger the /api/public re-fetch.
//
// Not a visual pass — pins the render + money formatting, not layout.

import TopSalesBoardClient, { type Row } from "@/app/insights/top-sales/TopSalesBoardClient"

const fullRow: Row = {
  sale_id: "s1",
  edition_id: "e1",
  external_id: "141:5156",
  collection: "nba_top_shot",
  collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  team_name: "San Antonio Spurs",
  tier: "LEGENDARY",
  circulation_count: 2999,
  thumbnail_url: "https://example.com/a.png",
  nft_id: "999",
  serial_number: 1,
  price_usd: 12500,
  sold_at: new Date(Date.now() - 3600_000).toISOString(),
  buyer_address: "0xbd94cade097e50ac",
  seller_address: "0xb5053ef95e702657",
  marketplace: "topshot",
  buyer_name: "whalebuyer",
  seller_name: null,
}

const nullRow: Row = {
  sale_id: "s2",
  edition_id: null,
  external_id: null,
  collection: null,
  collection_id: null,
  player_name: null,
  set_name: null,
  team_name: null,
  tier: null,
  circulation_count: null,
  thumbnail_url: null,
  nft_id: null,
  serial_number: null,
  price_usd: 250,
  sold_at: null,
  buyer_address: null,
  seller_address: null,
  marketplace: null,
  buyer_name: null,
  seller_name: null,
}

// A UFC sale with no nft_id — forces rowHref down the /<slug>/edition/<ext>
// drill-down branch, which is where the collection→URL-slug mapping matters.
const ufcRow: Row = {
  ...nullRow,
  sale_id: "s3",
  edition_id: "e3",
  external_id: "5:12",
  collection: "ufc_strike",
  collection_id: "9b4824a8-736d-4a96-b450-8dcc0c46b023",
  player_name: "Jon Jones",
  price_usd: 500,
  nft_id: null,
}

beforeEach(() => {
  // Mount effect hits /api/profile/me; a default-view board keeps its SSR rows
  // and only re-fetches /api/public/insights/top-sales when a filter changes.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (String(url).includes("/api/profile/me")) {
        return Promise.resolve({ ok: true, json: async () => ({}) } as Response)
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }),
      } as Response)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("TopSalesBoardClient", () => {
  it("renders the ranked list from initialRows (populated + null-heavy)", () => {
    const { container, getAllByText, getByText } = render(
      <TopSalesBoardClient initialRows={[fullRow, nullRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    // The named player from the populated row survives the SaleRow render.
    expect(getAllByText(/Victor Wembanyama/).length).toBeGreaterThan(0)
    // $100+ prices show the exact rounded number with separators, not $12.5k.
    expect(container.textContent).toContain("$12,500")
    // The "what this board is" footer always renders.
    expect(getByText(/What this board is/i)).toBeTruthy()
  })

  it("links a UFC row (no nft_id) to the canonical /ufc/edition slug, not the ufc-strike alias", () => {
    const { container } = render(
      <TopSalesBoardClient initialRows={[ufcRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    // The drill-down link resolves ufc_strike → canonical "ufc", matching the
    // sitemap + entity-page canonical tag (fromDbSlug), not the "ufc-strike"
    // alias a naive underscore→hyphen replace would emit as a duplicate.
    expect(hrefs).toContain("/ufc/edition/5%3A12")
    expect(hrefs.some((h) => h?.startsWith("/ufc-strike/"))).toBe(false)
  })

  it("routes arweave-hosted sale art through the same-origin avatar proxy — the CSP img-src blocks it hotlinked (2026-09-04)", () => {
    const candyRow: Row = {
      ...nullRow,
      sale_id: "s4",
      edition_id: "e4",
      collection: "candy_mlb",
      player_name: "Shohei Ohtani",
      thumbnail_url: "https://arweave.net/-00lKHoPezMrmUSf8RxB1S_TYAiBf3TM1JAD34HJ13Y",
    }
    const { container } = render(
      <TopSalesBoardClient initialRows={[candyRow, fullRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    const srcs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src") ?? "")
    expect(srcs.some((s) => s.startsWith("/api/public/avatar-media?src=https%3A%2F%2Farweave.net%2F"))).toBe(true)
    expect(srcs.some((s) => s.startsWith("https://arweave.net/"))).toBe(false)
    // CSP-allowed Top Shot art still hotlinks — the proxy is not applied blindly.
    expect(srcs.some((s) => s.startsWith("https://assets.nbatopshot.com/"))).toBe(true)
  })

  it("shows the empty state when no rows match", () => {
    const { getByText } = render(
      <TopSalesBoardClient initialRows={[]} initialFetchedAt={null} />,
    )
    expect(getByText(/No sales match those filters\./)).toBeTruthy()
  })

  it("changing the sort control re-fetches the public board", () => {
    const { container } = render(
      <TopSalesBoardClient initialRows={[fullRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    const sort = container.querySelector("select") as HTMLSelectElement
    expect(sort).toBeTruthy()
    fireEvent.change(sort, { target: { value: "recent" } })
    // A non-default sort abandons the SSR rows and queries the public endpoint.
    const calls = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    expect(calls.some((c) => String(c[0]).includes("/api/public/insights/top-sales"))).toBe(true)
  })
})
