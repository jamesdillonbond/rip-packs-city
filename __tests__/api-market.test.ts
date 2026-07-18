import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/market (GET). Market is EDITION-level
// (Trevor, 2026-07-18): one row per edition, not per serial. Pinnacle reads the
// render-grain pinnacle_catalog (render = edition), AllDay uses
// get_allday_market_editions, and other collections collapse the legacy
// cached_listings feed to one row per edition. This test exercises the guard
// (collectionId required → 400), the empty legacy path, and the Pinnacle
// edition-grain dispatch incl. the ASK_ONLY thin-data guard.

// Single shared chainable+thenable builder. `state.then` is what any awaited
// query resolves to; `state.rpc` is what any .rpc() resolves to. Tests set them.
const state: { then: any; rpc: any } = {
  then: { data: [], error: null, count: 0 },
  rpc: { data: null, error: null },
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    from: () => b, select: () => b, eq: () => b, not: () => b, lte: () => b, gt: () => b,
    gte: () => b, in: () => b, ilike: () => b, overlaps: () => b, order: () => b,
    range: () => b, limit: () => b, filter: () => b, or: () => b, single: () => b,
    then: (res: any) => res(state.then),
    rpc: async () => state.rpc,
  }
  return { supabaseAdmin: b, supabase: b }
})

import { GET } from "@/app/api/market/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"
const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

beforeEach(() => {
  state.then = { data: [], error: null, count: 0 }
  state.rpc = { data: null, error: null }
})

describe("GET /api/market", () => {
  it("400s when collectionId is missing", async () => {
    const res = await GET(req("https://t/api/market"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("collectionId is required")
  })

  it("returns an empty, paginated payload for a collection with no listings", async () => {
    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toEqual([])
    expect(body.pagination).toMatchObject({ total: 0, page: 1, hasMore: false })
    expect(body.clamp.applied).toBe(true)
  })

  it("dispatches Disney Pinnacle to pinnacle_catalog and reshapes it to edition-grain rows", async () => {
    // One row per render (= edition). Floor ask, render-keyed FMV, no serials.
    state.then = {
      data: [
        {
          render_id: "REND-1", character_name: "Mickey Mouse", set_name: "Series 1",
          series_name: "2024", variant: "Standard", total_minted: 100,
          floor_ask: 10, fmv_usd: 20, fmv_confidence: "HIGH",
          thumbnail_url: "https://img/x", floor_ask_updated_at: "2026-07-18T00:00:00Z",
        },
        {
          // ASK_ONLY (uppercased confidence) — must be flagged thin-data, its
          // fake discount suppressed. Exercises the case-insensitive guard.
          render_id: "REND-2", character_name: "Donald Duck", set_name: "Series 1",
          series_name: "2024", variant: "Brushed Silver", total_minted: 50,
          floor_ask: 12, fmv_usd: 385, fmv_confidence: "ASK_ONLY",
          thumbnail_url: "https://img/y", floor_ask_updated_at: "2026-07-18T00:00:00Z",
        },
      ],
      error: null,
    }

    const res = await GET(req(`https://t/api/market?collectionId=${PINNACLE}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics.source).toBe("modern")
    expect(body.pagination.total).toBe(2)
    expect(body.listings).toHaveLength(2)

    const mickey = body.listings.find((l: any) => l.playerName === "Mickey Mouse")
    const donald = body.listings.find((l: any) => l.playerName === "Donald Duck")
    expect(mickey).toMatchObject({
      collectionId: PINNACLE, source: "pinnacle", askPrice: 10, tier: "Standard", editionKey: "REND-1",
    })
    expect(mickey.serialNumber).toBeNull()      // edition grain — no serial
    expect(mickey.lowConfidenceFmv).toBe(false)
    // ASK_ONLY row: flagged thin-data so the UI shows "⚠ thin data" instead of a fake discount.
    expect(donald.lowConfidenceFmv).toBe(true)
  })
})
