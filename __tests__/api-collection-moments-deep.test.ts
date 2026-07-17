import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture, installFetchMock, jsonRoute } from "./helpers/route-harness"

// Deep test for GET /api/collection-moments — drives the row-shaping,
// thumbnail-fallback ladder, number coercion, acquisitionStats mapping,
// total-FMV / total-pages math, and the GQL player-name backfill that the
// shallow test (400 guard + empty 200 + RPC 500) never touches. A raw 0x…(18)
// wallet resolves with no network call, so only the Supabase RPC seams + (for
// the backfill case) global fetch need stubbing.

const state = vi.hoisted(() => ({ sb: null as unknown }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))
vi.mock("@/lib/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { GET } from "@/app/api/collection-moments/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never
const WALLET = "0xbd94cade097e50ac" // 0x + 16 hex = 18 chars → resolves locally

function install(fixtures: Record<string, unknown>) {
  state.sb = makeSupabaseFixture(fixtures as never)
}

beforeEach(() => {
  state.sb = null
})

describe("GET /api/collection-moments — row shaping", () => {
  it("coerces numeric strings, builds the edition-key thumbnail, and maps acquisitionStats", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [
            {
              moment_id: "101",
              edition_key: "3:45",
              serial_number: "5",
              fmv_usd: "42.5",
              confidence: "HIGH",
              low_ask: "11",
              player_name: "Dame",
              set_name: "Base Set",
              team_name: "Portland Trail Blazers",
              tier: "COMMON",
              series_number: "5",
              circulation_count: "15000",
              thumbnail_url: null,
              buy_price: "8.5",
              acquisition_method: "marketplace",
            },
          ],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 42.5, error: null },
      "rpc:get_acquisition_stats": {
        data: {
          breakdown: [
            { method: "marketplace", count: 1 },
            { method: "pack_pull", count: 2 },
          ],
          total_moments: 3,
          total_spent: 20,
          locked_count: 1,
        },
        error: null,
      },
    })

    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()

    const m = body.moments[0]
    expect(m.serial_number).toBe(5) // string → number
    expect(m.fmv_usd).toBe(42.5)
    expect(m.low_ask).toBe(11)
    expect(m.circulation_count).toBe(15000)
    expect(m.buy_price).toBe(8.5)
    expect(m.thumbnail_url).toBe(
      "https://assets.nbatopshot.com/resize/editions/3_45/play45_capture_Hero_Black_2880_2880_default.jpg?width=100&quality=80",
    )
    expect(body.total_fmv).toBe(42.5)
    expect(body.total_pages).toBe(1)
    expect(body.acquisitionStats).toMatchObject({
      marketplace_count: 1,
      pack_pull_count: 2,
      total_count: 3,
      locked_count: 1,
      total_spent: 20,
    })
  })

  it("falls back to the moment-media thumbnail when there is no edition_key", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [{ moment_id: "202", edition_key: null, player_name: "Player", thumbnail_url: null }],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
    expect(body.moments[0].thumbnail_url).toBe("https://assets.nbatopshot.com/media/202?width=256")
  })

  it("computes total_pages from total_count and the page limit", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": { data: { moments: [], total_count: 120 }, error: null },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}&limit=50`))).json()
    expect(body.total_count).toBe(120)
    expect(body.total_pages).toBe(3) // ceil(120/50)
  })
})

describe("GET /api/collection-moments — GQL player-name backfill", () => {
  it("fills a missing player_name / set_name / tier from the Top Shot GQL fallback", async () => {
    install({
      "rpc:get_wallet_moments_with_fmv": {
        data: {
          moments: [
            { moment_id: "303", edition_key: "7:88", player_name: null, set_name: null, tier: null, thumbnail_url: "http://x" },
          ],
          total_count: 1,
        },
        error: null,
      },
      "rpc:get_wallet_total_fmv": { data: 0, error: null },
      "rpc:get_acquisition_stats": { data: null, error: null },
    })

    const h = installFetchMock([
      jsonRoute("nbatopshot.com", {
        data: {
          getMintedMoment: {
            data: {
              play: { stats: { playerName: "Resolved Player", teamAtMoment: "LAL" } },
              set: { flowName: "Playoff Set" },
              tier: "RARE",
            },
          },
        },
      }),
    ])

    try {
      const body = await (await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))).json()
      const m = body.moments[0]
      expect(m.player_name).toBe("Resolved Player")
      expect(m.set_name).toBe("Playoff Set")
      expect(m.tier).toBe("RARE")
      // The fallback issued exactly one GQL POST for the missing moment.
      expect(h.calls.filter((c) => c.url.includes("nbatopshot.com"))).toHaveLength(1)
    } finally {
      h.restore()
    }
  })
})
