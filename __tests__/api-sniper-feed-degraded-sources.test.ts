import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Drives the REAL compute functions through their actual failure branches and
// asserts the response can no longer be mistaken for a quiet floor.
//
// Before this, every deal-bearing read in /api/sniper-feed collapsed to an
// empty list on failure and the route answered 200 with `deals: []`. Live
// evidence, 2026-09-02: four users hit `[sniper-feed] AD GQL FAILED: HTTP 403`
// in 24h while the Pack Sniper rendered "No deals match your filters."
//
// ⚠ Each case asserts the ABSENCE of the false state (`degraded` false /
// `sourcesFailed` empty on a failed read), not merely the presence of a label —
// a test that only checked the label would still pass if the flag never reached
// the response envelope.

const cacheState = vi.hoisted(() => ({ deleted: [] as string[], throws: false }))
vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _t: number, fn: any) => {
    if (cacheState.throws) throw new Error("compute exploded")
    return fn()
  },
  deleteCache: (key: string) => { cacheState.deleted.push(key) },
}))

const st = vi.hoisted(() => ({
  fmv: { data: [] as any[], error: null as any },
  editions: { data: [] as any[], error: null as any },
  tsListings: { data: [] as any[], error: null as any },
  badges: { data: [] as any[], error: null as any },
  // Tables whose read should THROW rather than resolve with an error field.
  // supabase-js RETURNS errors, but the network layer under it still throws —
  // and the two land in different branches, so both need a pin.
  throwOn: new Set<string>(),
}))
const rpc = vi.hoisted(() =>
  // The signature has to accept the route's (name, params) call — cases below
  // override it with mockImplementation. Typed via the generic rather than named
  // parameters so the unused ones do not read as dead bindings.
  vi.fn<(name: string, params?: unknown) => Promise<any>>(async () => ({ data: [], error: null })),
)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let range: [number, number] | null = null
      const b: any = {
        select: () => b, eq: () => b, order: () => b, in: () => b, gt: () => b,
        limit: () => b,
        range: (from: number, to: number) => { range = [from, to]; return b },
        then: (resolve: any) => {
          if (st.throwOn.has(table)) throw new Error("socket hang up")
          if (table === "fmv_current") {
            if (st.fmv.error) return resolve({ data: null, error: st.fmv.error })
            return resolve(range ? { data: st.fmv.data.slice(range[0], range[1] + 1), error: null } : st.fmv)
          }
          if (table === "ts_listings") return resolve(st.tsListings)
          if (table === "editions") return resolve(st.editions)
          if (table === "badge_editions") return resolve(st.badges)
          return resolve({ data: [], error: null })
        },
      }
      return b
    },
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
  },
}))

import { GET } from "@/app/api/sniper-feed/route"

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)
const ADQS = "?collection=nfl-all-day&minDiscount=0&maxPrice=100000&rarity=all&team=all"
const TSQS = "?collection=nba-top-shot&minDiscount=0&maxPrice=100000&rarity=all&team=all"

let gqlOk = true
let gqlStatus = 200
let gqlBody: any = { data: { searchMarketplaceEditions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } } }
let gqlThrows = false

beforeEach(() => {
  cacheState.deleted = []
  cacheState.throws = false
  st.fmv = { data: [], error: null }
  st.editions = { data: [], error: null }
  st.tsListings = { data: [], error: null }
  st.badges = { data: [], error: null }
  st.throwOn = new Set<string>()
  rpc.mockReset()
  rpc.mockResolvedValue({ data: [], error: null })
  gqlOk = true
  gqlStatus = 200
  gqlThrows = false
  gqlBody = { data: { searchMarketplaceEditions: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } } }
  vi.stubGlobal("fetch", vi.fn(async () => {
    if (gqlThrows) throw new Error("ETIMEDOUT")
    return { ok: gqlOk, status: gqlStatus, text: async () => "<title>block</title>", json: async () => gqlBody }
  }))
})
afterEach(() => { vi.unstubAllGlobals() })

describe("GET /api/sniper-feed — a failed source is never rendered as a quiet floor", () => {
  it("healthy build: degraded false and sourcesFailed empty (no-change control)", async () => {
    const body = await (await GET(get(ADQS))).json()
    expect(body.degraded).toBe(false)
    expect(body.sourcesFailed).toEqual([])
    expect(body.deals).toEqual([])
    // A clean build stays in cache — the eviction below must be caused by the
    // failure, not by every request.
    expect(cacheState.deleted).toEqual([])
  })

  it("All Day marketplace 403 is named, not swallowed", async () => {
    gqlOk = false
    gqlStatus = 403
    const res = await GET(get(ADQS))
    expect(res.status).toBe(200) // still a usable envelope
    const body = await res.json()
    expect(body.sourcesFailed).toContain("allday-marketplace")
    expect(body.degraded).toBe(true)
  })

  it("an All Day GQL errors[] payload is named", async () => {
    gqlBody = { errors: [{ message: "rate limited" }] }
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-marketplace")
    expect(body.degraded).toBe(true)
  })

  it("a missing searchMarketplaceEditions is named", async () => {
    gqlBody = { data: {} }
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-marketplace")
    expect(body.degraded).toBe(true)
  })

  it("a thrown All Day fetch is named", async () => {
    gqlThrows = true
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-marketplace")
    expect(body.degraded).toBe(true)
  })

  // A listing with no FMV is EXCLUDED rather than priced off its own ask, so a
  // failed FMV map empties the board just as surely as a failed listing read.
  it("a failed All Day FMV map read is named", async () => {
    st.fmv = { data: [], error: { message: "canceling statement due to statement timeout" } }
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-fmv")
    expect(body.degraded).toBe(true)
  })

  it("a THROWN All Day FMV map read is named (the catch, not the error branch)", async () => {
    st.throwOn = new Set(["editions"])
    st.fmv = { data: [{ edition_id: "e1", fmv_usd: 10, confidence: "HIGH" }], error: null }
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-fmv")
    expect(body.degraded).toBe(true)
  })

  it("a THROWN ts_listings read is named (the catch, not the error branch)", async () => {
    st.throwOn = new Set(["ts_listings"])
    const body = await (await GET(get(TSQS))).json()
    expect(body.sourcesFailed).toContain("ts_listings")
    expect(body.degraded).toBe(true)
  })

  it("a failed get_allday_sniper_deals fallback is named", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "get_allday_sniper_deals" ? { data: null, error: { message: "boom" } } : { data: [], error: null })
    const body = await (await GET(get(ADQS))).json()
    expect(body.sourcesFailed).toContain("allday-deals-rpc")
    expect(body.degraded).toBe(true)
    expect(body.deals).toEqual([])
  })

  it("a failed ts_listings read is named on the Top Shot board", async () => {
    st.tsListings = { data: [] as any[], error: { message: "upstream request timeout" } }
    const body = await (await GET(get(TSQS))).json()
    expect(body.sourcesFailed).toContain("ts_listings")
    expect(body.degraded).toBe(true)
  })

  it("a failed edition-key resolve is named — without a key a listing has no FMV to price against", async () => {
    st.tsListings = {
      data: [{
        listing_id: "l1", flow_id: "f1", set_id: 1, play_id: 2, serial_number: 3,
        circulation_count: 100, price_usd: 10, player_name: "Stephen Curry",
        set_name: "Base Set", moment_tier: "COMMON", series_number: 0,
        is_locked: false, listed_at: null, ingested_at: null,
      }],
      error: null,
    }
    rpc.mockImplementation(async (name: string) =>
      name === "get_editions_for_sniper" ? { data: null, error: { message: "boom" } } : { data: [], error: null })
    const body = await (await GET(get(TSQS))).json()
    expect(body.sourcesFailed).toContain("topshot-edition-keys")
    expect(body.degraded).toBe(true)
  })

  it("a failed get_topshot_sniper_deals augment is named", async () => {
    rpc.mockImplementation(async (name: string) =>
      name === "get_topshot_sniper_deals" ? { data: null, error: { message: "boom" } } : { data: [], error: null })
    const body = await (await GET(get(TSQS))).json()
    expect(body.sourcesFailed).toContain("topshot-deals-rpc")
    expect(body.degraded).toBe(true)
  })

  // ⚠ The warm-lambda cache would otherwise hand this request's outage to the
  // next 25 seconds of readers — the ISR-caches-a-failed-read shape.
  it("a degraded build is evicted from the cache; a clean one is not", async () => {
    gqlOk = false
    gqlStatus = 403
    await GET(get(ADQS))
    expect(cacheState.deleted.length).toBe(1)
    expect(cacheState.deleted[0]).toContain("sniper-feed:")
  })

  it("the 500 envelope declares itself degraded rather than shipping a bare empty list", async () => {
    cacheState.throws = true
    const res = await GET(get(TSQS))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.degraded).toBe(true)
    expect(body.sourcesFailed).toEqual(["sniper-feed"])
  })
})

describe("collections with no plumbed source are not reported as failures", () => {
  it("golazos returns an empty board with sourcesFailed empty", async () => {
    const body = await (await GET(get("?collection=laliga-golazos"))).json()
    expect(body.sourcesFailed).toEqual([])
    expect(body.degraded).toBe(false)
  })
})
