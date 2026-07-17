import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Deep test for GET /api/market — drives the real board-shaping pipeline (modern
// sniper-RPC dispatch + reshape, legacy cached_listings path, tier-ceiling clamp,
// in-app discount computation, editionKey derivation, special-serial detection,
// discount filter/sort, pagination) that the shallow test (empty 200 + 400 guard)
// never exercises. Every assertion targets a handler-COMPUTED field, not fixture
// echo: the recomputed discount, the clamped/derived values, the diagnostics
// counts, and the TS FMV display-guard clamp.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

import { GET } from "@/app/api/market/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

beforeEach(() => {
  state.sb = null
})

describe("GET /api/market — modern AllDay path", () => {
  it("reshapes sniper rows, strips the MOMENT_TIER_ prefix, recomputes discount, and derives editionKey", async () => {
    install({
      "rpc:get_allday_market_listings": {
        data: [
          {
            moment_id: "m1",
            flow_id: "f1",
            ask_price: 100,
            fmv_usd: 200,
            discount_pct: 999, // deliberately wrong — handler must recompute from ask/fmv
            tier: "MOMENT_TIER_RARE",
            serial_number: 7,
            circulation_count: 500,
            player_name: "Josh Allen",
            set_name: "Base Set",
            thumbnail_url: "http://img/1",
          },
        ],
        error: null,
      },
      editions: {
        data: [
          {
            external_id: "allday-ed-1",
            collection_id: ALLDAY,
            player_name: "Josh Allen",
            set_name: "Base Set",
            set_id_onchain: null,
            play_id_onchain: null,
            badges: ["rookie_mint"],
          },
        ],
        error: null,
      },
    })

    const res = await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics.source).toBe("modern")
    expect(body.listings).toHaveLength(1)
    const row = body.listings[0]
    expect(row.tier).toBe("RARE") // MOMENT_TIER_ stripped
    expect(row.askPrice).toBe(100)
    expect(row.fmv).toBe(200)
    expect(row.discount).toBe(50) // (200-100)/200 = 50.0, recomputed not echoed
    expect(row.editionKey).toBe("allday-ed-1") // non-TS uses editions.external_id
    expect(row.badgeSlugs).toEqual(["rookie_mint"]) // fell back to editions.badges
    expect(row.isSpecialSerial).toBe(false) // serial 7, circ 500
  })

  it("drops rows above their tier ceiling and reports it in diagnostics", async () => {
    install({
      "rpc:get_allday_market_listings": {
        data: [
          { moment_id: "keep", ask_price: 100, fmv_usd: 200, tier: "RARE", serial_number: 2, circulation_count: 50 },
          { moment_id: "drop", ask_price: 60000, fmv_usd: 90000, tier: "RARE", serial_number: 3, circulation_count: 50 }, // >= 50k ceiling
        ],
        error: null,
      },
      editions: { data: [], error: null },
    })

    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))).json()
    expect(body.diagnostics).toMatchObject({ rawCount: 2, postClampCount: 1, postFilterCount: 1 })
    expect(body.listings).toHaveLength(1)
    expect(body.listings[0].momentId).toBe("keep")
  })

  it("applies the minDiscount post-filter to the computed discount", async () => {
    install({
      "rpc:get_allday_market_listings": {
        data: [
          { moment_id: "a", ask_price: 100, fmv_usd: 200, tier: "RARE", serial_number: 1, circulation_count: 10 }, // 50% off
          { moment_id: "b", ask_price: 190, fmv_usd: 200, tier: "RARE", serial_number: 2, circulation_count: 10 }, // 5% off
        ],
        error: null,
      },
      editions: { data: [], error: null },
    })

    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&minDiscount=25`))).json()
    expect(body.listings.map((r: { momentId: string }) => r.momentId)).toEqual(["a"])
  })

  it("filters to special serials (#1 or last) when specialSerials=true", async () => {
    install({
      "rpc:get_allday_market_listings": {
        data: [
          { moment_id: "first", ask_price: 10, fmv_usd: 20, tier: "COMMON", serial_number: 1, circulation_count: 500 },
          { moment_id: "last", ask_price: 10, fmv_usd: 20, tier: "COMMON", serial_number: 250, circulation_count: 250 },
          { moment_id: "mid", ask_price: 10, fmv_usd: 20, tier: "COMMON", serial_number: 5, circulation_count: 250 },
        ],
        error: null,
      },
      editions: { data: [], error: null },
    })

    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&specialSerials=true`))).json()
    expect(body.listings.map((r: { momentId: string }) => r.momentId).sort()).toEqual(["first", "last"])
    expect(body.listings.every((r: { isSpecialSerial: boolean }) => r.isSpecialSerial)).toBe(true)
  })

  it("orders by discount descending when sort=discount_desc", async () => {
    install({
      "rpc:get_allday_market_listings": {
        data: [
          { moment_id: "small", ask_price: 180, fmv_usd: 200, tier: "COMMON", serial_number: 1, circulation_count: 9 }, // 10%
          { moment_id: "big", ask_price: 100, fmv_usd: 200, tier: "COMMON", serial_number: 2, circulation_count: 9 }, // 50%
        ],
        error: null,
      },
      editions: { data: [], error: null },
    })

    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&sort=discount_desc`))).json()
    expect(body.listings.map((r: { momentId: string }) => r.momentId)).toEqual(["big", "small"])
  })
})

describe("GET /api/market — legacy cached_listings path", () => {
  it("shapes cached_listings rows, prefers cached badge_slugs, and computes diagnostics without a modern source tag", async () => {
    install({
      // Non-TS/AllDay collection → fetchModernListings returns null → legacy path.
      cached_listings: {
        data: [
          {
            id: "c1",
            flow_id: "gf1",
            moment_id: "gm1",
            player_name: "Vinicius",
            set_name: "Golazos Base",
            tier: "RARE",
            serial_number: 1,
            circulation_count: 1000,
            ask_price: 30,
            fmv: 60,
            badge_slugs: ["cached_badge"],
          },
        ],
        error: null,
        count: 1,
      },
      editions: {
        data: [
          {
            external_id: "golazos-ext-1",
            collection_id: GOLAZOS,
            player_name: "Vinicius",
            set_name: "Golazos Base",
            set_id_onchain: null,
            play_id_onchain: null,
            badges: ["edition_badge"],
          },
        ],
        error: null,
      },
    })

    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.diagnostics.source).toBeUndefined() // legacy path has no source tag
    expect(body.listings).toHaveLength(1)
    const row = body.listings[0]
    expect(row.discount).toBe(50) // (60-30)/60
    expect(row.editionKey).toBe("golazos-ext-1")
    expect(row.badgeSlugs).toEqual(["cached_badge"]) // cached wins over editions.badges
    expect(row.isSpecialSerial).toBe(true) // serial 1
    expect(body.diagnostics).toMatchObject({ rawCount: 1, postClampCount: 1, postFilterCount: 1 })
  })

  it("500s with the DB error message when the cached_listings query fails", async () => {
    install({
      cached_listings: { data: null, error: { message: "listings scan timeout" }, count: null },
      editions: { data: [], error: null },
    })
    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("listings scan timeout")
  })
})

describe("GET /api/market — Top Shot FMV display guard", () => {
  it("clamps an inflated TS FMV to the 90d max and flags low confidence before computing the discount", async () => {
    install({
      topshot_fmv_display_guard: {
        data: [
          {
            external_id: "3:45",
            max_sale_90d: 5,
            is_thin: false,
            fmv_exceeds_max: true,
            fmv_disconnected: false,
            clamp_target: 0,
          },
        ],
        error: null,
      },
      "rpc:get_topshot_sniper_deals": {
        data: [
          {
            moment_id: "3:45",
            ask_price: 4,
            fmv_usd: 42, // inflated — guard clamps to max_sale_90d = 5
            tier: "COMMON",
            serial_number: 1,
            circulation_count: 100,
            player_name: "Dame",
            set_name: "Base Set",
          },
        ],
        error: null,
      },
      editions: {
        data: [
          {
            external_id: "3:45",
            collection_id: TS,
            player_name: "Dame",
            set_name: "Base Set",
            set_id_onchain: 3,
            play_id_onchain: 45,
            badges: [],
          },
        ],
        error: null,
      },
    })

    const body = await (await GET(req(`https://t/api/market?collectionId=${TS}`))).json()
    const row = body.listings[0]
    expect(row.fmv).toBe(5) // clamped from 42
    expect(row.lowConfidenceFmv).toBe(true)
    expect(row.discount).toBe(20) // (5-4)/5, computed off the honest clamped FMV
    expect(row.editionKey).toBe("3:45") // TS uses set_id_onchain:play_id_onchain
  })
})
