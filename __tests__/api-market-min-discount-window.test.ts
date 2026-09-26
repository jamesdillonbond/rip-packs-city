import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// known-issues #146 (2): the Market's Min-discount filter runs IN APP over the
// window the RPC returned (p_min_discount is 0 by design — a serial-adjusted FMV
// can raise a row's discount above the RPC's, so pre-filtering there would drop
// real matches). With Price ↑ + Min 30 % the window was the 500 cheapest
// editions, so the page showed only the 30 %-off rows among those. When the
// filter is set, the fetch must pull PostgREST's full 1,000.

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never

function limitSent(collectionId: string, query: string, rpc: string) {
  const inst = makeInstrumentedSupabaseFixture({ [`rpc:${rpc}`]: { data: [], error: null }, editions: { data: [], error: null } } as never)
  state.sb = inst.fixture
  return GET(req(`https://t/api/market?collectionId=${collectionId}${query}`)).then(() => {
    const call = inst.rpcCalls.find((c) => c.name === rpc)
    return call?.args?.p_limit
  })
}

beforeEach(() => {
  state.sb = null
})

describe("Market Min-discount filter searches the full window (#146 (2))", () => {
  it("Top Shot: price sort + Min discount pulls 1,000", async () => {
    expect(await limitSent(TS, "&sort=price_asc&minDiscount=30", "get_topshot_sniper_deals")).toBe(1000)
  })

  it("All Day: price sort + Min discount pulls 1,000", async () => {
    expect(await limitSent(ALLDAY, "&sort=price_asc&minDiscount=30", "get_allday_market_editions")).toBe(1000)
  })

  it("control: without the filter the price sort keeps its 500 window, and minDiscount=0 is no filter", async () => {
    expect(await limitSent(TS, "&sort=price_asc", "get_topshot_sniper_deals")).toBe(500)
    expect(await limitSent(ALLDAY, "&sort=price_asc&minDiscount=0", "get_allday_market_editions")).toBe(500)
  })
})
