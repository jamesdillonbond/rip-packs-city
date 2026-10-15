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

const FILTER_KEYS = ["p_sets", "p_series", "p_player", "p_min_price", "p_teams", "p_badges", "p_has_badges"]

describe.each([
  ["Top Shot", TS, "get_topshot_sniper_deals_v2"],
  ["All Day", ALLDAY, "get_allday_market_editions_v2"],
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

  // 2026-10-14: the v1 RPCs took ONE p_team, so the route sent teams[0] and a
  // 2-team pick filtered by the first only.
  it("sends EVERY selected team as p_teams, never just the first", async () => {
    await GET(req(`https://t/api/market?collectionId=${collectionId}&team=${encodeURIComponent("Portland Fire, Seattle Storm")}`))
    const args = argsOf(rpc)
    expect(args).toMatchObject({ p_teams: ["Portland Fire", "Seattle Storm"], p_team: "all" })
  })

  // 2026-10-14: badges ran only in memory over the RPC's ≤500-row window.
  it("sends selected badges as p_badges, and hasBadges as p_has_badges", async () => {
    await GET(req(`https://t/api/market?collectionId=${collectionId}&badges=${encodeURIComponent("Rookie Year,Championship Year")}`))
    expect(argsOf(rpc)).toMatchObject({ p_badges: ["Rookie Year", "Championship Year"] })
    expect(argsOf(rpc)).not.toHaveProperty("p_has_badges")
    rpcCalls.length = 0
    await GET(req(`https://t/api/market?collectionId=${collectionId}&hasBadges=true`))
    expect(argsOf(rpc)).toMatchObject({ p_has_badges: true })
    expect(argsOf(rpc)).not.toHaveProperty("p_badges")
  })

  // Every arm takes one tier; a 2-tier pick used to filter by the first only.
  it("makes one call per selected tier, covering every tier picked", async () => {
    await GET(req(`https://t/api/market?collectionId=${collectionId}&tier=RARE,LEGENDARY`))
    const tiers = rpcCalls.filter((c) => c.name === rpc).map((c) => c.args?.p_rarity).sort()
    expect(tiers).toEqual(["LEGENDARY", "RARE"])
  })

  it("a non-positive or unparseable min price is not sent as a filter", async () => {
    await GET(req(`https://t/api/market?collectionId=${collectionId}&minPrice=abc&set=Base%20Set`))
    const args = argsOf(rpc)
    expect(args).toMatchObject({ p_sets: ["Base Set"] })
    expect(args).not.toHaveProperty("p_min_price")
  })
})

// known-issues #146 (2026-09-25): Top Shot's RPC ranks by RAW discount and the
// route demotes thin / stale FMV only after the fetch, so a 500-row window held
// 261 of 353 real (HIGH/MEDIUM, positive) deals. Discount sorts pull 1,000.
describe("GET /api/market — Top Shot discount sort pulls a wider window", () => {
  it("discount_desc asks the RPC for 1,000 rows; other sorts keep 500", async () => {
    await GET(req(`https://t/api/market?collectionId=${TS}&sort=discount_desc`))
    expect(argsOf("get_topshot_sniper_deals_v2")?.p_limit).toBe(1000)
    rpcCalls.length = 0
    await GET(req(`https://t/api/market?collectionId=${TS}&sort=price_asc`))
    expect(argsOf("get_topshot_sniper_deals_v2")?.p_limit).toBe(500)
  })
})
