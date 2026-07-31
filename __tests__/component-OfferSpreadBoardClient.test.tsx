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
