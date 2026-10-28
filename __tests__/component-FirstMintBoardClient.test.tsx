// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
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

  // 2026-10-26 (All Day ↔ Top Shot parity, pass 4).
  describe("NFL All Day toggle", () => {
    const adBody = {
      meta: { fetched_at: "x", collection: "nfl-all-day", data_as_of: "2026-10-27T05:17:00Z" },
      stats: { ...initial.stats, median_multiplier: 22, trophies_90d: 27 },
      trophies: [trophy({ edition_id: "ad-1", external_id: "445", player_name: "Richard Sherman", tier: "COMMON", multiplier: 1589.4 })],
    }

    it("switching to All Day fetches ?collection=nfl-all-day and links All Day edition pages", async () => {
      fetchFn.mockImplementation(async () => ({ ok: true, status: 200, json: async () => adBody }))
      const { container, getByTestId } = render(<FirstMintBoardClient initial={initial} />)
      fireEvent.click(getByTestId("fm-collection-nfl-all-day"))
      await waitFor(() => expect(container.textContent).toContain("Richard Sherman"))
      expect(String(fetchFn.mock.calls[0][0])).toContain("collection=nfl-all-day")
      expect(container.textContent).not.toContain("Damian Lillard")
      expect(container.querySelector('a[href="/nfl-all-day/edition/445"]')).toBeTruthy()
      expect(container.querySelector('a[href^="/nba-top-shot/"]')).toBeNull()
      // The squeeze board gained an All Day leg 10-27: an All Day row links it WITH the collection —
      // never Top Shot's board under an All Day player.
      const sq = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href") ?? "").filter((h) => h.startsWith("/insights/squeeze"))
      expect(sq.length).toBeGreaterThan(0)
      expect(sq.every((h) => h.includes("collection=nfl-all-day"))).toBe(true)
      expect(container.textContent).toContain("Every NFL All Day serial #1 sale")
      expect(container.textContent).toContain("UNCOMMON")
      expect(container.textContent).not.toContain("FANDOM")
      expect(window.location.search).toContain("collection=nfl-all-day")
    })

    it("a ?collection=nfl-all-day URL never shows the Top Shot seed under the All Day toggle", async () => {
      window.history.replaceState({}, "", "/insights/first-mint?collection=nfl-all-day")
      let release: () => void = () => {}
      fetchFn.mockImplementation(() => new Promise((r) => { release = () => r({ ok: true, status: 200, json: async () => adBody }) }))
      const { container } = render(<FirstMintBoardClient initial={initial} />)
      await waitFor(() => expect(fetchFn).toHaveBeenCalled())
      expect(container.textContent).not.toContain("Damian Lillard")
      expect(container.textContent).not.toContain("248.0×")
      release()
      await waitFor(() => expect(container.textContent).toContain("Richard Sherman"))
    })

    it("a failed All Day read says so and shows no Top Shot rows", async () => {
      window.history.replaceState({}, "", "/insights/first-mint?collection=nfl-all-day")
      fetchFn.mockImplementation(async () => ({ ok: false, status: 500, json: async () => ({}) }))
      const { container } = render(<FirstMintBoardClient initial={initial} />)
      await waitFor(() => expect(container.textContent).toMatch(/Failed to load/))
      expect(container.textContent).not.toContain("Damian Lillard")
      // Nor the Top Shot cohort KPIs (max 248×) under the All Day toggle.
      expect(container.textContent).not.toContain("248.0×")
    })

    it("switching back to Top Shot drops the URL param", async () => {
      fetchFn.mockImplementation(async (u: unknown) => ({
        ok: true, status: 200,
        json: async () => (String(u).includes("nfl-all-day") ? adBody : { meta: { fetched_at: "x" }, stats: initial.stats, trophies: [trophy({ player_name: "Back On Top Shot" })] }),
      }))
      const { container, getByTestId } = render(<FirstMintBoardClient initial={initial} />)
      fireEvent.click(getByTestId("fm-collection-nfl-all-day"))
      await waitFor(() => expect(container.textContent).toContain("Richard Sherman"))
      fireEvent.click(getByTestId("fm-collection-nba-top-shot"))
      await waitFor(() => expect(container.textContent).toContain("Back On Top Shot"))
      expect(window.location.search).not.toContain("collection")
    })
  })
})
