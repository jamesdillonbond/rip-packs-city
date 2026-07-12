import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-series. No auth. Guards on the
// collection slug (unknown → 400). Valid slug (default nba-top-shot has a
// flowContractName) resolves the collection UUID via collection_config.single(),
// then reads collection_series ordered by series_number. We mock @/lib/supabase's
// chained builder so single() yields the config row and order() yields the series.

const state: { config: any; series: any } = { config: { collection_id: "uuid-1" }, series: [] }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    single: async () => ({ data: state.config }),
    order: async () => ({ data: state.series }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/collection-series/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.config = { collection_id: "uuid-1" }
  state.series = []
})

describe("GET /api/collection-series", () => {
  it("400s for an unknown collection slug", async () => {
    const res = await GET(req("https://t/api/collection-series?collection=not-a-collection"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Unknown collection")
  })

  it("returns the series list for a valid collection", async () => {
    state.series = [
      { series_number: 0, display_label: "Series 1", season: null },
      { series_number: 8, display_label: "Series 2025-26", season: "25-26" },
    ]
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.series).toHaveLength(2)
    expect(body.series[0].display_label).toBe("Series 1")
  })

  it("returns an empty series list when the collection has no config row", async () => {
    state.config = null
    const res = await GET(req("https://t/api/collection-series?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).series).toEqual([])
  })
})
