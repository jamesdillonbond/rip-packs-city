// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from "vitest"
import { render, cleanup, fireEvent } from "@testing-library/react"

// MarketIndexClient is the public /insights/market surface (~700 lines) — "The
// RPC Index", a normalized base-100 price index + daily median/volume built
// client-side from a trailing-120-day per-tier daily-aggregate window. It is
// PROP-DRIVEN (no re-fetch), so a wrong aggregation mis-plots the whole index;
// previously ZERO render coverage and unmeasured. Drives buildSeries, the
// per-tier headline cards, the SVG index line, the volume bars, and the tier
// visibility toggles.

import MarketIndexClient, { type Row } from "@/app/insights/market/MarketIndexClient"

function daily(d: string, tier: string, median: number, volume: number, sales: number): Row {
  return {
    d,
    tier,
    sales,
    volume_usd: volume,
    median_px: median,
    avg_px: median,
    max_px: median * 2,
  }
}

// A couple of tiers across a few days so buildSeries + normalization + volume
// bars all have real input (numeric AND string-typed values, which the view emits).
const rows: Row[] = [
  daily("2026-07-01", "LEGENDARY", 100, 5000, 10),
  daily("2026-07-15", "LEGENDARY", 120, 6000, 12),
  daily("2026-07-31", "LEGENDARY", 150, 7000, 14),
  { d: "2026-07-01", tier: "COMMON", sales: "40", volume_usd: "2000", median_px: "12", avg_px: "13", max_px: "40" },
  { d: "2026-07-31", tier: "COMMON", sales: "44", volume_usd: "2200", median_px: "14", avg_px: "15", max_px: "44" },
]

afterEach(() => {
  cleanup()
})

describe("MarketIndexClient", () => {
  it("renders the index header + per-tier headline cards from a daily window", () => {
    const { getByText, getAllByText } = render(
      <MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    expect(getByText(/The RPC Index/)).toBeTruthy()
    // The priced tier surfaces a "median $…" headline (LEGENDARY latestMedian 150).
    expect(getAllByText(/median/i).length).toBeGreaterThan(0)
  })

  it("renders the empty state when the window has no rows", () => {
    const { getAllByText } = render(<MarketIndexClient initialRows={[]} initialFetchedAt={null} />)
    // Both the index and the volume panels report an empty range.
    expect(getAllByText(/No (market data|volume) in range\./).length).toBeGreaterThan(0)
  })

  it("toggling a tier button does not crash the index", () => {
    const { container } = render(
      <MarketIndexClient initialRows={rows} initialFetchedAt="2026-07-31T00:00:00Z" />,
    )
    const btn = container.querySelector("button") as HTMLButtonElement
    expect(btn).toBeTruthy()
    fireEvent.click(btn)
    // Still rendered (the tier-visibility toggle recomputes the plotted series).
    expect(container.querySelector(".rpc-mk-h1")).toBeTruthy()
  })
})
