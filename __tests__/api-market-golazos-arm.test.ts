import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — the LaLiga Golazos arm (2026-10-18). Golazos had no arm, so
// the Market page fell through to v1 `cached_listings`: Flowty's 100 rows
// against ~4.3k open asks in the on-chain index. It now reads
// get_golazos_market_editions_v2 (cached_listings_v2), and — like All Day, Candy,
// Panini and Pinnacle — an empty or failed answer never falls through to v1.

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never

// A Flowty v1 row that must never surface on the Golazos or All Day market.
const FLOWTY_V1 = {
  data: [{ id: "f1", flow_id: "F1", player_name: "Flowty Only", set_name: "Base", tier: "COMMON", ask_price: 1, fmv: 9, collection_id: GOLAZOS, source: "flowty" }],
  error: null,
  count: 1,
}

let spy: { rpcCalls: Array<{ name: string; args: any }> } & Record<string, unknown>
function install(f: Record<string, unknown>) {
  const fx = makeSupabaseFixture(f as never) as any
  const calls: Array<{ name: string; args: any }> = []
  const baseRpc = fx.rpc.bind(fx)
  fx.rpc = (name: string, args: any) => { calls.push({ name, args }); return baseRpc(name, args) }
  spy = Object.assign(fx, { rpcCalls: calls })
  state.sb = fx
}

const ROW = {
  edition_id: "g1", external_id: "gz-aspas-1", player_name: "Iago Aspas", team_name: "RC Celta",
  set_name: "Base", series_name: "1", tier: "COMMON", circulation_count: 5000, floor_ask: 0.79,
  listed_count: 9, fmv_usd: 1, discount_pct: 21, confidence: "LOW", thumbnail_url: null, badges: null,
  last_listed_at: "2026-10-01T00:00:00Z",
}

beforeEach(() => { state.sb = null })

describe("GET /api/market — LaLiga Golazos on-chain edition arm", () => {
  it("reads get_golazos_market_editions_v2, never the Flowty v1 book", async () => {
    install({ "rpc:get_golazos_market_editions_v2": { data: [ROW], error: null }, cached_listings: FLOWTY_V1, editions: { data: [], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    const names = (body.listings as Array<{ player_name?: string; playerName?: string }>).map((l) => l.player_name ?? l.playerName)
    expect(names).toContain("Iago Aspas")
    expect(JSON.stringify(body)).not.toContain("Flowty Only")
    expect(spy.rpcCalls.map((c) => c.name)).toContain("get_golazos_market_editions_v2")
  })

  it("an EMPTY on-chain answer is an empty market — it does not fall through to Flowty's v1 rows", async () => {
    install({ "rpc:get_golazos_market_editions_v2": { data: [], error: null }, cached_listings: FLOWTY_V1 })
    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}&player=nobody`))).json()
    expect(body.listings).toEqual([])
    expect(body.diagnostics.source).toBe("onchain_market_editions")
    expect(JSON.stringify(body)).not.toContain("Flowty Only")
  })

  it("a FAILED read is 503 market_unavailable, never 'no listings'", async () => {
    install({ "rpc:get_golazos_market_editions_v2": { data: null, error: { message: "statement timeout" } }, cached_listings: FLOWTY_V1 })
    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe("market_unavailable")
  })

  it("the browse filters reach the RPC (same argument builder as All Day)", async () => {
    install({ "rpc:get_golazos_market_editions_v2": { data: [], error: null } })
    await GET(req(`https://t/api/market?collectionId=${GOLAZOS}&player=Aspas&minPrice=0.5`))
    const call = spy.rpcCalls.find((c) => c.name === "get_golazos_market_editions_v2")!
    expect(call.args).toMatchObject({ p_player: "Aspas", p_min_price: 0.5 })
  })

  // 2026-10-18: Owned reaches the Golazos RPC only for a wallet the cache knows
  // (an unknown one read as "owns none"); the page still re-filters (ownedApplied false).
  it("Owned reaches the RPC for a KNOWN wallet, and not for an unknown one", async () => {
    const url = `https://t/api/market?collectionId=${GOLAZOS}&owned=owned&wallet=0xabcdef0123456789`
    install({ "rpc:get_golazos_market_editions_v2": { data: [ROW], error: null }, wallet_moments_cache: { data: [{ wallet_address: "0xabcdef0123456789" }], error: null } })
    const known = await (await GET(req(url))).json()
    expect(spy.rpcCalls.find((c) => c.name === "get_golazos_market_editions_v2")?.args).toMatchObject({ p_owned: "owned", p_wallet: "0xabcdef0123456789" })
    expect(known.ownedApplied).toBe(false)
    install({ "rpc:get_golazos_market_editions_v2": { data: [ROW], error: null }, wallet_moments_cache: { data: [], error: null } })
    await GET(req(url))
    expect(spy.rpcCalls.find((c) => c.name === "get_golazos_market_editions_v2")?.args).not.toHaveProperty("p_owned")
  })

  it("All Day: an EMPTY on-chain answer no longer falls through to Flowty's v1 rows either", async () => {
    install({ "rpc:get_allday_market_editions_v4": { data: [], error: null }, cached_listings: { ...FLOWTY_V1, data: [{ ...FLOWTY_V1.data[0], collection_id: ALLDAY }] } })
    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&player=nobody`))).json()
    expect(body.listings).toEqual([])
    expect(JSON.stringify(body)).not.toContain("Flowty Only")
  })
})
