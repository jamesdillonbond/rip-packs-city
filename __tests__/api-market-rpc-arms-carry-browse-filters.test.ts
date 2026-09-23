import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeInstrumentedSupabaseFixture } from "./helpers/route-harness"

// Register #129, Top Shot + All Day half: the Market tab's Set / Series /
// Player / Min price filters were parsed and then DROPPED for the two arms
// served by an RPC, while the UI still counted the chip as active. The filters
// now travel as RPC parameters (migration
// audit_20260923_market_rpcs_take_the_browse_filters), which apply them BEFORE
// the RPC's LIMIT.
//
// ⛔ The property pinned here is that the filter reaches the RPC, NOT that the
// route filters the RPC's rows itself. An RPC returns an already-truncated
// window, so an in-memory filter would answer a set outside that window with a
// confident "no listings in this set" — worse than ignoring it.
//
// ⚠ And the NO-CHANGE CONTROL: an unfiltered request must make exactly the call
// it always made (no new keys), so nothing new can fail on the default path.

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

const req = (u: string) => ({ nextUrl: new URL(u) }) as never

let rpcCalls: Array<{ name: string; args?: Record<string, unknown> }> = []

beforeEach(() => {
  const inst = makeInstrumentedSupabaseFixture({})
  state.sb = inst.fixture
  rpcCalls = inst.rpcCalls
})

const argsOf = (name: string) => rpcCalls.find((c) => c.name === name)?.args

const FILTER_KEYS = ["p_sets", "p_series", "p_player", "p_min_price"]

describe.each([
  ["Top Shot", TS, "get_topshot_sniper_deals"],
  ["All Day", ALLDAY, "get_allday_market_editions"],
])("GET /api/market — %s arm hands the browse filters to its RPC", (_label, collectionId, rpc) => {
  it("passes set / series / player / min price as RPC parameters (sets trimmed)", async () => {
    await GET(
      req(
        `https://t/api/market?collectionId=${collectionId}` +
          `&set=${encodeURIComponent(" Base Set ,Rookie Debut")}` +
          `&series=2,3&player=${encodeURIComponent("  LeBron ")}&minPrice=20`,
      ),
    )
    const args = argsOf(rpc)
    expect(args, `${rpc} was not called`).toBeDefined()
    expect(args).toMatchObject({
      p_sets: ["Base Set", "Rookie Debut"],
      p_series: ["2", "3"],
      p_player: "LeBron",
      p_min_price: 20,
    })
  })

  it("NO-CHANGE CONTROL: an unfiltered request sends none of the new keys", async () => {
    await GET(req(`https://t/api/market?collectionId=${collectionId}`))
    const args = argsOf(rpc)
    expect(args, `${rpc} was not called`).toBeDefined()
    for (const k of FILTER_KEYS) expect(args).not.toHaveProperty(k)
  })

  it("a non-positive or unparseable min price is not sent as a filter", async () => {
    await GET(req(`https://t/api/market?collectionId=${collectionId}&minPrice=abc&set=Base%20Set`))
    const args = argsOf(rpc)
    expect(args).toMatchObject({ p_sets: ["Base Set"] })
    expect(args).not.toHaveProperty("p_min_price")
  })
})
