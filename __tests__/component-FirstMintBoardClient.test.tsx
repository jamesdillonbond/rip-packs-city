// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor, within } from "@testing-library/react"
import React from "react"

// First-Mint Trophy Tracker client interactivity — the board had NO dedicated
// test (partial coverage only, 45.8% br). Drives the multiplier/tier filter
// pills (which refetch via /api/public/insights/first-mint), the drill-down
// URL filters + their clear buttons, and the loading / error / empty states.

import FirstMintBoardClient, { type ApiResponse } from "@/app/insights/first-mint/FirstMintBoardClient"

const trophy = (o: Partial<ApiResponse["trophies"][number]> = {}): ApiResponse["trophies"][number] => ({
  edition_id: "ed-1", external_id: "3:45", player_name: "Damian Lillard", set_name: "Base Set",
  tier: "LEGENDARY", circulation_count: 499, mint_one_sold_at: "2026-07-01T00:00:00Z",
  mint_one_price_usd: 5000, avg_other_serial_price_usd: 50, other_serial_sample_n: 8, multiplier: 100, ...o,
})

const initial: ApiResponse = {
  meta: { fetched_at: "2026-08-01T00:00:00Z" },
  stats: {
    trophies_90d: 42, mult_5x_plus: 30, mult_10x_plus: 20, mult_50x_plus: 5, mult_100x_plus: 2,
    avg_multiplier: 12.5, median_multiplier: 9, max_multiplier: 248, top_mint_one_price_usd: 15000,
  },
  trophies: [
    trophy(),
    trophy({ edition_id: "ed-2", external_id: null, player_name: "Scoot", tier: "COMMON", multiplier: 5, mint_one_price_usd: 40 }),
    trophy({ edition_id: "ed-3", player_name: null, set_name: null, tier: null, multiplier: null, mint_one_price_usd: null, circulation_count: null }),
  ],
}

let fetchFn: ReturnType<typeof vi.fn>
beforeEach(() => {
  fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ meta: { fetched_at: "x" }, stats: initial.stats, trophies: [trophy({ player_name: "Filtered Only" })] }),
  }))
  vi.stubGlobal("fetch", fetchFn)
  // reset URL so drill-down state doesn't leak between tests
  window.history.replaceState({}, "", "/insights/first-mint")
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("FirstMintBoardClient", () => {
  it("renders the KPI row and the trophy table from server-provided initial data", () => {
    const { container } = render(<FirstMintBoardClient initial={initial} />)
    expect(container.textContent).toContain("Damian Lillard")
    expect(container.textContent).toContain("Scoot")
    // fmtMult, fmtUsd formatting + the max-multiplier KPI
    expect(container.textContent).toContain("248.0×")
    // The null-field row renders em-dashes rather than crashing.
    expect(container.textContent).toContain("—")
    // No refetch on first paint at default filters.
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("refetches with min_multiplier when a bucket pill is clicked", async () => {
    const { container } = render(<FirstMintBoardClient initial={initial} />)
    const pill = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("≥ 10X"))!
    fireEvent.click(pill)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    const url = String(fetchFn.mock.calls[0][0])
    expect(url).toContain("min_multiplier=10")
    await waitFor(() => expect(container.textContent).toContain("Filtered Only"))
  })

  it("adds the tier param when a tier pill is clicked", async () => {
    const { container } = render(<FirstMintBoardClient initial={initial} />)
    const pill = [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === "RARE")!
    fireEvent.click(pill)
    await waitFor(() => expect(fetchFn).toHaveBeenCalled())
    expect(String(fetchFn.mock.calls[0][0])).toContain("tier=RARE")
  })

  it("shows the error state when the refetch fails", async () => {
    fetchFn.mockImplementationOnce(async () => ({ ok: false, status: 500, json: async () => ({}) }))
    const { container } = render(<FirstMintBoardClient initial={initial} />)
    fireEvent.click([...container.querySelectorAll("button")].find((b) => b.textContent?.includes("≥ 5X"))!)
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load/i))
  })

  it("renders 'No trophies match' when the initial cohort is empty", () => {
    const { container } = render(<FirstMintBoardClient initial={{ ...initial, trophies: [] }} />)
    expect(container.textContent).toMatch(/No trophies match/i)
  })

  it("reads a ?player drill-down from the URL, shows the chip, and clears it", async () => {
    // A drill-down refetch fires on mount; return an empty cohort so the
    // player-specific empty state (with its squeeze-board link) renders.
    fetchFn.mockImplementation(async () => ({
      ok: true, status: 200,
      json: async () => ({ meta: { fetched_at: "x" }, stats: initial.stats, trophies: [] }),
    }))
    window.history.replaceState({}, "", "/insights/first-mint?player=Damian%20Lillard")
    const { container } = render(<FirstMintBoardClient initial={{ ...initial, trophies: [] }} />)
    // Active-filter chip rendered from the URL param.
    await waitFor(() => expect(container.textContent).toMatch(/FILTERED TO PLAYER/i))
    // Empty state for a player drill-down offers the squeeze-board link.
    expect(container.textContent).toMatch(/squeeze board/i)
    const clear = [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("Clear"))!
    fireEvent.click(clear)
    await waitFor(() => expect(container.textContent).not.toMatch(/FILTERED TO PLAYER/i))
  })
})
