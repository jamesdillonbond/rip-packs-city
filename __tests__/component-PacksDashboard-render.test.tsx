// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup } from "@testing-library/react"

// PacksDashboard's pure formatters are already unit-tested; its RENDER (the
// 3-endpoint Promise.all fan-out — summary + top-EV + fresh — the KPI
// aggregation useMemo, the per-collection breakdown, and the two tables with
// their empty states) was dark at ~21%. These tests drive that: the loaded
// tables, the empty states, and the header, with fetch stubbed per endpoint.

import PacksDashboard from "@/components/analytics/PacksDashboard"

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
  pack_ev: 34,
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
  pack_ev: 22,
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

  it("shows the per-table empty states when there are no rows", async () => {
    stub({ topEv: { rows: [] }, fresh: { rows: [] } })
    const { findByText } = render(<PacksDashboard />)
    expect(await findByText(/No positive-EV packs in this filter\./)).toBeTruthy()
    expect(await findByText(/No new pack listings in the last 24 hours\./)).toBeTruthy()
  })
})
