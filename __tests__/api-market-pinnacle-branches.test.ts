import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Branch coverage for GET /api/market's Pinnacle edition-level path
// (fetchPinnacleModernListings, reading pinnacle_catalog) — the sibling deep
// test drives AllDay + Golazos but never the Pinnacle dispatch, so its reshape,
// the DB pre-sort ladder (price/fmv/recent), the maxPrice filter, the null-field
// coalescing, and the fetch-error fallback were all dark.

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never
const install = (f: Record<string, unknown>) => { state.sb = makeSupabaseFixture(f as never) }
const fresh = new Date().toISOString()

// Three renders with distinct ask/fmv so every in-memory ordering is unambiguous.
//   p1: ask 100 / fmv 200 -> 50% off
//   p2: ask  40 / fmv 100 -> 60% off
//   p3: ask 240 / fmv 300 -> 20% off
function threeRenders() {
  return {
    pinnacle_catalog: {
      data: [
        { render_id: "p1", character_name: "Mickey", set_name: " Set A ", series_name: "S1", variant: "Standard", total_minted: 500, floor_ask: 100, fmv_usd: 200, fmv_confidence: "MEDIUM", thumbnail_url: "http://x/1.png", floor_ask_updated_at: fresh },
        { render_id: "p2", character_name: "Donald", set_name: "Set B", series_name: "S1", variant: "Standard", total_minted: 250, floor_ask: 40, fmv_usd: 100, fmv_confidence: "LOW", thumbnail_url: null, floor_ask_updated_at: fresh },
        { render_id: "p3", character_name: "Goofy", set_name: "Set C", series_name: "S2", variant: "Colored Enamel", total_minted: 99, floor_ask: 240, fmv_usd: 300, fmv_confidence: "HIGH", thumbnail_url: "http://x/3.png", floor_ask_updated_at: fresh },
      ],
      error: null,
    },
    editions: { data: [], error: null },
  }
}
const keys = (b: { listings: Array<{ editionKey: string }> }) => b.listings.map((r) => r.editionKey)

beforeEach(() => { state.sb = null })

describe("GET /api/market — Pinnacle edition path", () => {
  it("reshapes pinnacle_catalog into edition rows with source 'pinnacle', render-id editionKey, and a recomputed discount", async () => {
    install(threeRenders())
    const body = await (await GET(req(`https://t/api/market?collectionId=${PINNACLE}`))).json()
    expect(body.listings.length).toBe(3)
    const p1 = body.listings.find((r: any) => r.editionKey === "p1")
    expect(p1.source).toBe("pinnacle")
    expect(p1.askPrice).toBe(100)
    expect(p1.fmv).toBe(200)
    expect(Math.round(p1.discount)).toBe(50) // (200-100)/200
    expect(p1.setName).toBe("Set A") // trimmed
    expect(p1.serialNumber).toBeNull() // edition grain — no single serial
  })

  it("coalesces null render fields without dropping the row", async () => {
    install({
      pinnacle_catalog: {
        data: [
          { render_id: "bare", character_name: null, set_name: null, series_name: null, variant: null, total_minted: null, floor_ask: 25, fmv_usd: null, fmv_confidence: null, thumbnail_url: null, floor_ask_updated_at: fresh },
        ],
        error: null,
      },
      editions: { data: [], error: null },
    })
    const body = await (await GET(req(`https://t/api/market?collectionId=${PINNACLE}`))).json()
    expect(body.listings.length).toBe(1)
    const r = body.listings[0]
    expect(r.editionKey).toBe("bare")
    expect(r.askPrice).toBe(25)
    expect(r.fmv).toBeNull()
    expect(r.discount).toBeNull() // no fmv -> no discount
  })

  it.each([
    ["price_asc", ["p2", "p1", "p3"]],
    ["price_desc", ["p3", "p1", "p2"]],
    ["fmv_asc", ["p2", "p1", "p3"]],
    ["fmv_desc", ["p3", "p1", "p2"]],
    ["discount_desc", ["p2", "p1", "p3"]],
  ])("orders the Pinnacle board by %s", async (sort, expected) => {
    install(threeRenders())
    const body = await (await GET(req(`https://t/api/market?collectionId=${PINNACLE}&sort=${sort}`))).json()
    expect(keys(body)).toEqual(expected)
  })

  it("applies the maxPrice filter branch without error", async () => {
    install(threeRenders())
    const res = await GET(req(`https://t/api/market?collectionId=${PINNACLE}&maxPrice=150`))
    expect(res.status).toBe(200)
  })

  it("returns an empty board (not a 500) when the pinnacle_catalog fetch errors", async () => {
    install({ pinnacle_catalog: { data: null, error: { message: "relation missing" } }, editions: { data: [], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${PINNACLE}`))
    expect(res.status).toBe(200)
    expect((await res.json()).listings).toEqual([])
  })
})
