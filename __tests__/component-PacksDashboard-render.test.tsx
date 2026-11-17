// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// PacksDashboard's pure formatters are already unit-tested; its RENDER (the
// 3-endpoint Promise.all fan-out — summary + top-EV + fresh — the KPI
// aggregation useMemo, the per-collection breakdown, and the two tables with
// their empty states) was dark at ~21%. These tests drive that: the loaded
// tables, the empty states, and the header, with fetch stubbed per endpoint.

import PacksDashboard, { grossEv } from "@/components/analytics/PacksDashboard"

const summary = {
  collections: {
    nba_top_shot: {
      packs_tracked: 40,
      sellable_packs: 30,
      positive_ev_packs: 12,
      avg_value_ratio: 1.4,
      median_pack_price: 25,
      total_unopened: 5000,
      last_refresh: "2026-07-31T00:00:00Z",
      minutes_since_refresh: 15,
    },
  },
  as_of: "2026-07-31T00:00:00Z",
}

const topEvRow = {
  rank: 1,
  collection: "nba_top_shot",
  pack_listing_id: "p1",
  pack_name: "2025 Premium Pack",
  pack_price: 20,
  // pack_ev is EV MINUS price in pack_ev_history (gross 34 − price 20).
  pack_ev: 14,
  value_ratio: 1.7,
  fmv_coverage_pct: 92,
  edition_count: 120,
  total_unopened: 500,
  depletion_pct: 20,
  snapshotted_at: "2026-07-31T00:00:00Z",
}

const freshRow = {
  rank: 1,
  collection: "nba_top_shot",
  pack_listing_id: "p2",
  pack_name: "2025 Fresh Drop Pack",
  pack_price: 15,
  pack_ev: 7.5,
  value_ratio: 1.5,
  is_positive_ev: true,
  total_unopened: 300,
  first_seen_at: "2026-07-31T00:00:00Z",
}

function stub(opts: { summary?: unknown; topEv?: unknown; fresh?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      const u = String(url)
      const body = u.includes("/packs/summary")
        ? opts.summary ?? summary
        : u.includes("/packs/top-ev")
          ? opts.topEv ?? { rows: [topEvRow] }
          : opts.fresh ?? { rows: [freshRow] }
      return Promise.resolve({ ok: true, json: async () => body } as Response)
    }),
  )
}

beforeEach(() => stub({}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PacksDashboard render", () => {
  it("renders the header and loaded top-EV + fresh tables", async () => {
    const { getByText, findByText } = render(<PacksDashboard />)
    expect(getByText("Pack Analytics")).toBeTruthy()
    expect(await findByText(/2025 Premium Pack/)).toBeTruthy()
    expect(await findByText(/2025 Fresh Drop Pack/)).toBeTruthy()
  })

  // 2026-10-25: the "EV" column printed pack_ev — EV MINUS the price — so a $20
  // pack worth $34 read "EV $14.00 · 1.70×". It shows the expected value now.
  it("the EV column shows the expected value (net + price), never the net figure", async () => {
    const { findByText, queryByText } = render(<PacksDashboard />)
    expect(await findByText("$34.00")).toBeTruthy()
    expect(await findByText("$22.50")).toBeTruthy()
    expect(queryByText("$14.00")).toBeNull()
    expect(queryByText("$7.50")).toBeNull()
  })

  it("shows the per-table empty states when there are no rows", async () => {
    stub({ topEv: { rows: [] }, fresh: { rows: [] } })
    const { findByText } = render(<PacksDashboard />)
    expect(await findByText(/No positive-EV packs in this filter\./)).toBeTruthy()
    expect(await findByText(/No new pack listings in the last 24 hours\./)).toBeTruthy()
  })

  // 2026-10-19: UFC Strike has no packs, so it is no longer drawn as a permanent
  // "not yet available" panel; Panini and Candy (own pack planes) are pointed to
  // their boards instead of being absent.
  it("offers no UFC panel and links Panini and Candy to their own pack boards", async () => {
    const { findByText, queryByText, container } = render(<PacksDashboard />)
    expect(await findByText(/Open the Panini pack board/)).toBeTruthy()
    expect(await findByText(/Open the Candy MLB pack board/)).toBeTruthy()
    expect(queryByText("UFC Strike")).toBeNull()
    const hrefs = Array.from(container.querySelectorAll("a")).map((a) => a.getAttribute("href"))
    expect(hrefs).toContain("/panini-blockchain/packs")
    expect(hrefs).toContain("/candy-mlb/packs")
  })
})

describe("grossEv", () => {
  it("adds the price back to the net figure", () => {
    expect(grossEv({ pack_ev: 289.01, pack_price: 9.99, value_ratio: 29.93 })).toBe(299)
  })
  it("a no-pool sentinel (null ratio) is unknown, not the pack's price", () => {
    expect(grossEv({ pack_ev: 0, pack_price: 999, value_ratio: null })).toBeNull()
  })
})
