import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/market-feed driving the REAL body:
// auth gate, loadEditionKeysFromSupabase, the per-set Top Shot GQL stats fetch
// (fetchStatsForEditions), and the assembled EditionStats response. The GQL seam
// is @/lib/topshot.topshotGraphql (mocked); the DB seam is supabaseAdmin
// (makeSupabaseFixture). The seller-concentration block is skipped by returning
// no seller_address column from the execute_sql probe.

const fx = vi.hoisted(() => ({
  tables: {} as Record<string, { data?: unknown; error?: unknown }>,
  gql: null as any,
}))

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture(fx.tables) }))
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => fx.gql }))

const { GET } = await import("@/app/api/market-feed/route")

function get(qs = "") {
  return new NextRequest(`https://t/api/market-feed${qs}`)
}

// supabaseAdmin is a singleton bound to fx.tables at mock-init, so mutate the
// object in place rather than reassigning it (a new ref wouldn't be seen).
beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  fx.gql = null
  delete process.env.CRON_SECRET
  delete process.env.MARKET_FEED_TOKEN
})
afterEach(() => {
  delete process.env.CRON_SECRET
})

describe("GET /api/market-feed — integration", () => {
  it("401s when a CRON_SECRET is configured but no bearer is sent", async () => {
    process.env.CRON_SECRET = "secret"
    const res = await GET(get())
    expect(res.status).toBe(401)
  })

  it("returns [] when Supabase has no edition keys yet", async () => {
    Object.assign(fx.tables, { editions: { data: [] } })
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("returns assembled edition stats from the Top Shot GQL fetch", async () => {
    Object.assign(fx.tables, {
      editions: { data: [{ external_id: "1:2" }] },
      // execute_sql seller_address column probe -> no column -> concentration skipped
      "rpc:execute_sql": { data: [] },
    })
    fx.gql = {
      searchEditions: {
        data: [{ set: { id: "1" }, play: { id: "2" }, stats: { lowestAsk: 5, averagePrice: 4, totalSales: 3 } }],
      },
    }
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0]).toMatchObject({
      editionKey: "1:2",
      lowAsk: 5,
      lastSale: 4,
      saleCount: 3,
      source: "topshot-graphql",
    })
  })
})
