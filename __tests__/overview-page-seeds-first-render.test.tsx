// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest"

// app/(collections)/[collection]/overview/page.tsx (review E2, 2026-10-13):
// the page reads the stats ONCE on the server and hands the result to the
// client as `initialStats`. Three outcomes, pinned: ok → the payload is the
// seed; not_found / unavailable → the seed is NULL (never a stand-in, never
// the error body), so the client renders what it renders today.

const read = vi.fn()
vi.mock("@/lib/collection-stats/read", () => ({
  readCollectionStatsForPage: (...a: unknown[]) => read(...a),
}))
const seen: unknown[] = []
vi.mock("@/app/(collections)/[collection]/overview/CollectionOverviewClient", () => ({
  default: (props: { initialStats?: unknown; collection: string }) => {
    seen.push(props.initialStats)
    return null
  },
}))
vi.mock("@/components/entity/MarketCapTile", () => ({ CollectionMarketCapTile: () => null }))

import OverviewPage from "@/app/(collections)/[collection]/overview/page"

async function renderPage(collection = "nba-top-shot") {
  const el = await OverviewPage({ params: Promise.resolve({ collection }) })
  // The page returns the client element; its props are the contract.
  return (el as { props: { initialStats?: unknown } }).props.initialStats
}

describe("overview page seeds the client from the shared reader", () => {
  it("passes the payload through on ok, handing the lib the URL slug (the lib owns the client and the slug vocabulary)", async () => {
    read.mockResolvedValueOnce({ ok: true, stats: { edition_count: 5, fmv_age_minutes: 3 } })
    expect(await renderPage("nba-top-shot")).toEqual({ edition_count: 5, fmv_age_minutes: 3 })
    expect(read).toHaveBeenLastCalledWith("nba-top-shot")
  })
  it("seeds NULL when the read is unavailable — never the error, never a zero", async () => {
    read.mockResolvedValueOnce({ ok: false, kind: "unavailable", error: new Error("timeout") })
    expect(await renderPage()).toBeNull()
  })
  it("seeds NULL when the slug is unknown to the RPC", async () => {
    read.mockResolvedValueOnce({ ok: false, kind: "not_found", body: { error: "unknown collection" } })
    expect(await renderPage("nope")).toBeNull()
  })
})
