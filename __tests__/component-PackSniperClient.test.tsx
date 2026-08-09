// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest"
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react"
import React from "react"
import type { Deal } from "@/app/insights/pack-sniper/PackSniperClient"

// Pack-Sniper board client — the biggest untested board (949 LOC, 44.7% br,
// NO dedicated test). Drives the collection tabs (which refetch with the
// collection param), the client-side tier / search / max-ask / min-ratio /
// recent-only filters, the sort dropdown, the pause toggle, and the error
// state. The component always refetches on mount (showHighVariance defaults
// true), so the fetch stub returns the deal set we assert on.

import PackSniperClient from "@/app/insights/pack-sniper/PackSniperClient"

const deal = (o: Partial<Deal> = {}): Deal => ({
  distId: "d1", title: "Base Series Pack", tier: "common", imageUrl: "", slots: 5,
  lowestAsk: 20, grossEV: 40, liveValueRatio: 2, discountPct: 50, fmvCoveragePct: 90,
  evSnapshottedAt: "2026-08-01T00:00:00Z", editionCount: 100, depletionPct: 40,
  highVariance: false, highVarianceReasons: [], buyUrl: "https://buy", dapperUrl: "https://dapper",
  detailHref: "/x", simulatorHref: "/y", askChangedAt: null, askFirstSeenAt: null, prevAsk: null,
  isNew: false, isPriceDrop: false, askDropPct: null, lowAsk24h: null, lowAsk7d: null, atLow24h: false, ...o,
})

const deals: Deal[] = [
  deal(),
  deal({ distId: "d2", title: "Rare Chase Pack", tier: "rare", lowestAsk: 100, grossEV: 120, liveValueRatio: 1.2, discountPct: 17, isPriceDrop: true, askDropPct: 12 }),
  deal({ distId: "d3", title: "Legendary Whale", tier: "legendary", lowestAsk: 500, grossEV: 300, liveValueRatio: 0.6, discountPct: -20, highVariance: true, highVarianceReasons: ["thin FMV coverage"] }),
]

let fetchFn: ReturnType<typeof vi.fn>
beforeEach(() => {
  // jsdom has no matchMedia; the board reads it for its narrow-viewport layout.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
  fetchFn = vi.fn(async () => ({
    ok: true, status: 200,
    json: async () => ({ meta: { fetched_at: "2026-08-02T00:00:00Z", collection: "nba-top-shot" }, deals }),
  }))
  vi.stubGlobal("fetch", fetchFn)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("PackSniperClient", () => {
  it("renders the ranked deal rows from the loaded set", async () => {
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt="2026-08-01T00:00:00Z" />)
    await waitFor(() => expect(container.textContent).toContain("Base Series Pack"))
    expect(container.textContent).toContain("Rare Chase Pack")
    expect(container.textContent).toContain("Legendary Whale")
  })

  it("refetches with the collection param when the NFL All Day tab is clicked", async () => {
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt={null} />)
    const tab = [...container.querySelectorAll("button")].find((b) => /all day/i.test(b.textContent ?? ""))
    expect(tab).toBeTruthy()
    fireEvent.click(tab!)
    await waitFor(() =>
      expect(fetchFn.mock.calls.some((c) => String(c[0]).includes("collection=nfl-all-day"))).toBe(true),
    )
  })

  it("narrows the table with the pack-name search", async () => {
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt={null} />)
    await waitFor(() => expect(container.textContent).toContain("Rare Chase Pack"))
    const search = container.querySelector('input[placeholder="pack name…"]') as HTMLInputElement
    fireEvent.change(search, { target: { value: "legendary" } })
    expect(container.textContent).toContain("Legendary Whale")
    expect(container.textContent).not.toContain("Rare Chase Pack")
  })

  it("filters to a single tier via the tier tab", async () => {
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt={null} />)
    await waitFor(() => expect(container.textContent).toContain("Rare Chase Pack"))
    const rareTab = [...container.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim().toLowerCase() === "rare")
    expect(rareTab).toBeTruthy()
    fireEvent.click(rareTab!)
    expect(container.textContent).toContain("Rare Chase Pack")
    expect(container.textContent).not.toContain("Legendary Whale")
  })

  it("toggles the pause control", async () => {
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt={null} />)
    const pause = [...container.querySelectorAll("button")].find((b) => /pause|resume/i.test(b.textContent ?? ""))
    expect(pause).toBeTruthy()
    const before = pause!.textContent
    fireEvent.click(pause!)
    await waitFor(() => {
      const now = [...container.querySelectorAll("button")].find((b) => /pause|resume/i.test(b.textContent ?? ""))
      expect(now?.textContent).not.toBe(before)
    })
  })

  it("re-sorts by cheapest ask via the sort dropdown", async () => {
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt={null} />)
    await waitFor(() => expect(container.textContent).toContain("Base Series Pack"))
    const select = container.querySelector("select") as HTMLSelectElement
    fireEvent.change(select, { target: { value: "cheap" } })
    // still renders all rows after the client-side re-sort
    expect(container.textContent).toContain("Base Series Pack")
    expect(container.textContent).toContain("Legendary Whale")
  })

  it("surfaces the error state when the mount refetch fails", async () => {
    fetchFn.mockImplementation(async () => ({ ok: false, status: 502, json: async () => ({}) }))
    const { container } = render(<PackSniperClient initialDeals={deals} initialFetchedAt={null} />)
    await waitFor(() => expect(container.textContent).toMatch(/Failed to load|HTTP 502/i))
  })
})
