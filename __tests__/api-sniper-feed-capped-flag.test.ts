import { describe, it, expect, beforeEach, vi } from "vitest"

// #215 (2026-10-30) — the Sniper's deal modal marked a capped ASK_ONLY price
// (_salescap / _histcap, a SALES figure) "from asks". The handler now flags the
// returned page once: editionKey → editions.id → latest snapshot, paired only
// when the snapshot's price equals the deal's baseFmv.

const st = vi.hoisted(() => ({
  result: null as any,
  editions: { data: [] as unknown, error: null as unknown },
  wide: { data: [] as unknown, error: null as unknown },
}))
vi.mock("@/lib/cache", () => ({
  getOrSetCache: async () => st.result,
  deleteCache: () => {},
}))
vi.mock("@/lib/supabase", () => {
  const builder: any = {}
  for (const m of ["select", "eq", "in", "limit"]) builder[m] = () => builder
  builder.then = (resolve: any) => resolve(st.editions)
  const client: any = { from: () => builder, rpc: async () => st.wide }
  return { supabase: client, supabaseAdmin: client }
})

import { GET } from "@/app/api/sniper-feed/route"

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)
const deal = (over: Partial<any> = {}): any => ({
  editionKey: "4214", intEditionKey: null, playerName: "Matthew Golden", paymentToken: "FLOW",
  askPrice: 299, baseFmv: 217.5, adjustedFmv: 217.5, confidence: "ask_only", ...over,
})
const feed = (deals: any[]) => ({ count: deals.length, tsCount: 0, flowtyCount: deals.length, lastRefreshed: null, deals })

beforeEach(() => {
  st.result = feed([deal()])
  st.editions = { data: [{ id: "u1", external_id: "4214" }], error: null }
  st.wide = { data: [{ edition_id: "u1", fmv_usd: 217.5, algo_version: "1.8.3_histcap" }], error: null }
})

describe("GET /api/sniper-feed — fmvCapped (#215)", () => {
  it("flags a capped ASK_ONLY deal", async () => {
    const body = await (await GET(get("?collection=nfl-all-day"))).json()
    expect(body.deals[0].fmvCapped).toBe(true)
  })

  it("never pairs a snapshot at a different price than the deal's base FMV", async () => {
    st.wide = { data: [{ edition_id: "u1", fmv_usd: 250, algo_version: "1.8.3_histcap" }], error: null }
    const body = await (await GET(get("?collection=nfl-all-day"))).json()
    expect(body.deals[0].fmvCapped).toBeNull()
  })

  it("a sales-backed deal is not checked", async () => {
    st.result = feed([deal({ confidence: "high" })])
    const body = await (await GET(get("?collection=nfl-all-day"))).json()
    expect(body.deals[0].fmvCapped).toBeNull()
  })

  it("a failed lookup leaves the deal unchecked and the feed up", async () => {
    st.editions = { data: null, error: { message: "boom" } }
    const res = await GET(get("?collection=nfl-all-day"))
    expect(res.status).toBe(200)
    expect((await res.json()).deals[0].fmvCapped).toBeNull()
  })
})
