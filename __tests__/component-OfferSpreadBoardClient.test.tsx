// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// OfferSpreadBoardClient is the public /insights/offer-spread surface (~729
// lines) — editions carrying BOTH a live highest bid and a floor ask, ranked by
// how close the bid sits to the ask (bid-meets-ask liquidity). Previously ZERO
// render coverage and unmeasured. Drives the render loop + spread/par-distance
// formatting over populated + null rows and the empty state.

import OfferSpreadBoardClient, { type Row } from "@/app/insights/offer-spread/OfferSpreadBoardClient"

const fullRow: Row = {
  external_id: "141:5156",
  name: "Victor Wembanyama",
  player_name: "Victor Wembanyama",
  set_name: "Base Set",
  tier: "LEGENDARY",
  circulation_count: 2999,
  highest_offer: 120,
  low_ask: 150,
  offer_pct_of_ask: 0.8,
  par_distance: -0.2,
  spread_usd: 30,
  bid_meets_ask: false,
  updated_at: new Date(Date.now() - 3600_000).toISOString(),
  // 30 days: past BID_STALE_DAYS, so the aged branch of the Bid age cell renders.
  best_offer_at: new Date(Date.now() - 30 * 86_400_000).toISOString(),
}

const thinRow: Row = {
  external_id: null,
  name: null,
  player_name: null,
  set_name: null,
  tier: null,
  circulation_count: null,
  highest_offer: null,
  low_ask: null,
  offer_pct_of_ask: null,
  par_distance: null,
  spread_usd: null,
  bid_meets_ask: null,
  updated_at: null,
  // Unageable: exercises the "unknown" branch, which must never read as new.
  best_offer_at: null,
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({ rows: [], meta: { fetched_at: null, total_rows: 0, elapsed_ms: 1 } }),
      } as Response),
    ),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("OfferSpreadBoardClient", () => {
  it("renders bid/ask spread rows including a null-heavy row", () => {
    const { getAllByText } = render(
      <OfferSpreadBoardClient initialRows={[fullRow, thinRow]} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    expect(getAllByText(/Victor Wembanyama/).length).toBeGreaterThan(0)
  })

  it("shows the empty state when no edition has both a bid and an ask", () => {
    const { getByText } = render(<OfferSpreadBoardClient initialRows={[]} initialFetchedAt={null} />)
    expect(getByText(/No editions with both a live bid and a floor ask match\./)).toBeTruthy()
  })
})

// 2026-10-26 (All Day parity): the All Day toggle refetches with collection=nfl-all-day, swaps the tier list,
// links editions under /nfl-all-day, drops the undated-bid sort, and explains the unknown bid age honestly.
import { fireEvent, waitFor } from "@testing-library/react"

describe("OfferSpreadBoardClient — NFL All Day", () => {
  it("the toggle refetches All Day and renders it under All Day", async () => {
    const adRow: Row = { ...fullRow, external_id: "6112", name: "Saquon Barkley", player_name: "Saquon Barkley", tier: "UNCOMMON", best_offer_at: null }
    const f = vi.fn((u: string) =>
      Promise.resolve({ ok: true, json: async () => ({ rows: String(u).includes("collection=nfl-all-day") ? [adRow] : [], meta: { fetched_at: null, total_rows: 1, elapsed_ms: 1 } }) } as Response),
    )
    vi.stubGlobal("fetch", f)
    const { getByTestId, getByText, queryByText, container } = render(<OfferSpreadBoardClient initialRows={[fullRow]} initialFetchedAt="2026-10-26T00:00:00Z" />)
    expect(queryByText("UNCOMMON")).toBeNull()
    fireEvent.click(getByTestId("os-collection-nfl-all-day"))
    await waitFor(() => expect(container.querySelector('a[href="/nfl-all-day/edition/6112"]')).not.toBeNull())
    expect(f.mock.calls.some(([u]) => String(u).includes("collection=nfl-all-day"))).toBe(true)
    expect(getByText(/NFL All Day editions where/)).toBeTruthy()
    expect(container.querySelector('option[value="bidage"]')).toBeNull()
    expect(container.querySelector('[title^="All Day bids are indexed without the time"]')).not.toBeNull()
    expect(container.textContent).not.toContain("/nba-top-shot/edition/6112")
  })
})
