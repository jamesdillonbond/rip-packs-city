import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — the Panini arm (published 2026-09-25, Overview + Market).
// Reads `panini_market_board` (one row per bridged edition with an ask confirmed
// in the last 7 days). Pins: the buy link is Panini's own edition page, no Flow
// furniture, the listing-gated coverage rides the response, and a FAILED read
// never falls through to `cached_listings` (zero Panini rows) as "no listings".

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never
const install = (f: Record<string, unknown>) => { state.sb = makeSupabaseFixture(f as never) }

const COVERAGE = {
  total_editions: 5094, pct_trustworthy: 35.2, listing_gated_editions: 3300, listing_gated_families: 40,
  families: 62, edition_age_p50_h: 22.5, edition_age_p90_h: 38.9, pct_editions_stale_45d: 0,
}

function board() {
  return {
    panini_market_board: {
      data: [
        { external_id: "packcard-2332_1_2_3", player_name: "Lionel Messi", set_name: "Base Prizms Gold", tier: "LEGENDARY", circulation_count: 10, thumbnail_url: "https://img/m.png", low_ask_usd: 400, listed_count: 3, ask_confirmed_at: "2026-09-25T20:00:00Z", fmv_usd: 500, confidence: "MEDIUM", discount_pct: 20 },
        { external_id: "packcard-2332_4_5_6", player_name: "Kylian Mbappe", set_name: "Base Prizms Silver", tier: "COMMON", circulation_count: 259, thumbnail_url: null, low_ask_usd: 5, listed_count: 12, ask_confirmed_at: "2026-09-25T21:00:00Z", fmv_usd: 4, confidence: "LOW", discount_pct: -25 },
      ],
      error: null,
    },
    panini_coverage_summary: { data: [COVERAGE], error: null },
    editions: { data: [], error: null },
  }
}

beforeEach(() => { state.sb = null })

describe("GET /api/market — Panini arm", () => {
  it("serves panini_market_board rows linking to Panini's own edition page, with no Flow furniture", async () => {
    install(board())
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toHaveLength(2)
    const messi = body.listings.find((l: any) => l.playerName === "Lionel Messi")
    expect(messi.buyUrl).toBe("https://nft.paniniamerica.net/marketplace-details/packcard-2332_1_2_3.html")
    expect(messi.editionKey).toBe("packcard-2332_1_2_3")
    expect(messi.listedCount).toBe(3)
    expect(messi.discount).toBe(20)
    expect(messi.flowId).toBeNull()
    expect(messi.teamName).toBeNull() // a nation is not a team
    expect(messi.source).toBe("panini")
  })

  it("carries the listing-gated coverage disclosure", async () => {
    install(board())
    const body = await (await GET(req(`https://t/api/market?collectionId=${PANINI}`))).json()
    expect(body.coverage.total_editions).toBe(5094)
    expect(body.coverage_failed).toBe(false)
  })

  it("a failed coverage read drops the FIGURES and says so — never a zero", async () => {
    install({ ...board(), panini_coverage_summary: { data: null, error: { message: "boom" } } })
    const body = await (await GET(req(`https://t/api/market?collectionId=${PANINI}`))).json()
    expect(body.coverage).toBeNull()
    expect(body.coverage_failed).toBe(true)
    expect(body.listings).toHaveLength(2)
  })

  it("⭐ 503s instead of falling through to cached_listings when the Panini read FAILS", async () => {
    install({
      panini_market_board: { data: null, error: { message: "canceling statement due to statement timeout" } },
      panini_coverage_summary: { data: [COVERAGE], error: null },
      // A fall-through would find this row and serve it as Panini's market.
      cached_listings: { data: [{ id: "flow-1", ask_price: 1, tier: "COMMON", collection_id: PANINI }], error: null, count: 1 },
      editions: { data: [], error: null },
    })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("market_unavailable")
    expect(JSON.stringify(body)).not.toContain("flow-1")
  })

  it("a genuinely empty board is a 200 in the normal envelope, with coverage", async () => {
    install({ ...board(), panini_market_board: { data: [], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toEqual([])
    expect(body.pagination.total).toBe(0)
    expect(body.diagnostics.source).toBe("panini_market_board")
    expect(body.coverage.total_editions).toBe(5094)
  })

  it("no-change control: Candy's arm still carries no coverage field", async () => {
    install({ candy_market_board: { data: [], error: null }, editions: { data: [], error: null } })
    const body = await (await GET(req(`https://t/api/market?collectionId=209ade70-32c5-4470-bc7c-4793d660f713`))).json()
    expect(body).not.toHaveProperty("coverage")
    expect(body.diagnostics.source).toBe("candy_market_board")
  })
})
