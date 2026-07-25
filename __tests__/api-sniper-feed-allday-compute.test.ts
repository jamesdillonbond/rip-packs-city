import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"

// Drives the REAL computeAllDaySniperFeed via GET /api/sniper-feed?collection=nfl-all-day.
// The existing sniper-feed tests drive the TopShot compute with an empty pool (so
// the AllDay path — ~320 lines — stayed near-uncovered). Here we run it for real by
// pass-through-mocking getOrSetCache (no cache), stubbing the AllDay marketplace GQL
// fetch, and backing supabaseAdmin. Covers:
//   - the LIVE-pool path: GQL edge → buildDeal (tier strip, fmv join, discount),
//     the #1-serial + Jersey-serial specials, and the maxPrice/rarity/team/minDiscount
//     filters + price-asc sort + lowest-ask marking
//   - the RPC-FALLBACK path: empty GQL pool → get_allday_sniper_deals → deal mapping
//   - the fallback RPC error → empty result

vi.mock("@/lib/cache", () => ({ getOrSetCache: async (_k: string, _t: number, fn: any) => fn() }))

const st = vi.hoisted(() => ({
  fmv: { data: [] as any[], error: null as any },
  editions: { data: [] as any[], error: null as any },
}))
const rpc = vi.hoisted(() =>
  // Explicit `Promise<any>`: without it the empty default narrows data to
  // `never[]`, so mockImplementation returning real rows fails to typecheck.
  vi.fn(async (_name: string, _params?: any): Promise<any> => ({ data: [], error: null })),
)
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      const b: any = {
        select: () => b, eq: () => b, order: () => b, in: () => b,
        then: (resolve: any) =>
          resolve(table === "fmv_snapshots" ? st.fmv : table === "editions" ? st.editions : { data: [], error: null }),
      }
      return b
    },
    rpc: (...a: any[]) => rpc(...(a as [string, any?])),
  },
}))

import { GET } from "@/app/api/sniper-feed/route"

// AllDay GQL fetch fixture.
let gqlEdges: any[] = []
let gqlHasNext = false
function installFetch() {
  vi.stubGlobal("fetch", vi.fn(async () => ({
    ok: true,
    text: async () => "",
    json: async () => ({
      data: { searchMarketplaceEditions: { edges: gqlEdges, pageInfo: { endCursor: null, hasNextPage: gqlHasNext } } },
    }),
  })))
}

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)
const ADQS = "?collection=nfl-all-day&minDiscount=0&maxPrice=100000&rarity=all&team=all"

beforeEach(() => {
  st.fmv = { data: [], error: null }
  st.editions = { data: [], error: null }
  rpc.mockReset()
  rpc.mockResolvedValue({ data: [], error: null })
  gqlEdges = []
  gqlHasNext = false
  installFetch()
})
afterEach(() => vi.unstubAllGlobals())

const node = (over: any = {}) => ({
  node: {
    editionFlowID: 555,
    lowestPrice: "60",
    edition: {
      tier: "MOMENT_TIER_RARE",
      maxMintSize: 100,
      currentMintSize: 100,
      badges: [{ slug: "rookie", title: "Rookie" }],
      play: { metadata: { playerFullName: "Joe Player", teamName: "Bills" } },
      set: { name: "Base Set" },
      series: { name: "Series 1" },
      parallel: "Base",
    },
    ...over,
  },
})

describe("GET /api/sniper-feed?collection=nfl-all-day — computeAllDaySniperFeed", () => {
  it("live pool: shapes a GQL edge into a SniperDeal with fmv join + computed discount", async () => {
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]

    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(1)
    const d = body.deals[0]
    expect(d.source).toBe("allday")
    expect(d.playerName).toBe("Joe Player")
    expect(d.tier).toBe("RARE") // MOMENT_TIER_ stripped
    expect(d.askPrice).toBe(60)
    expect(d.baseFmv).toBe(100)
    expect(d.discount).toBe(40) // (100-60)/100
    expect(d.confidenceSource).toBe("fmv_snapshots")
    expect(d.hasBadge).toBe(true)
    expect(d.isLowestAsk).toBe(true)
  })

  it("no FMV entry → ask-fallback confidence, 0 discount (askPrice == baseFmv)", async () => {
    gqlEdges = [node()] // no fmv/editions rows → fmvMap empty
    const body = await (await GET(get(ADQS))).json()
    const d = body.deals[0]
    expect(d.confidenceSource).toBe("ask_fallback")
    expect(d.discount).toBe(0)
    expect(d.baseFmv).toBe(60) // falls back to askPrice
  })

  it("#1-serial and Jersey-serial specials add extra deals", async () => {
    gqlEdges = [node({
      numberOneSerial: { flowID: 5551, momentNFTListing: { priceV2: { value: "10" } } },
      jerseySerial: { flowID: 5552, momentNFTListing: { priceV2: { value: "20" } } },
    })]
    const body = await (await GET(get(ADQS))).json()
    // floor + #1 + jersey = 3
    expect(body.count).toBe(3)
    const signals = body.deals.map((d: any) => d.serialSignal).sort()
    expect(signals).toContain("#1")
    expect(signals).toContain("Jersey Serial")
    // price-asc sort: cheapest (#1 @10) first
    expect(body.deals[0].askPrice).toBe(10)
  })

  it("a listing with no/zero price is dropped (buildDeal returns null)", async () => {
    gqlEdges = [node({ lowestPrice: "0" })]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
  })

  it("rarity filter drops non-matching tiers", async () => {
    gqlEdges = [node()] // RARE
    const body = await (await GET(get("?collection=nfl-all-day&rarity=legendary&maxPrice=100000"))).json()
    expect(body.count).toBe(0)
  })

  it("maxPrice filter drops listings above the cap", async () => {
    gqlEdges = [node({ lowestPrice: "500" })]
    const body = await (await GET(get("?collection=nfl-all-day&maxPrice=100"))).json()
    expect(body.count).toBe(0)
  })

  it("RPC-fallback path: empty GQL pool → get_allday_sniper_deals → mapped deals", async () => {
    gqlEdges = [] // empty pool triggers the RPC fallback
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") {
        return {
          data: [
            { flow_id: "f1", moment_id: "m1", tier: "MOMENT_TIER_LEGENDARY", confidence: "HIGH", player_name: "A", team_name: "T", ask_price: 30, fmv_usd: 50, discount_pct: 40, buy_url: "u", listing_resource_id: "lr" },
            { flow_id: "f2", moment_id: "m2", tier: "COMMON", confidence: "ASK_ONLY", player_name: "B", ask_price: 10, fmv_usd: 0, discount_pct: 0 },
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    })

    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(2)
    expect(body.flowtyCount).toBe(2)
    const legendary = body.deals.find((d: any) => d.playerName === "A")
    expect(legendary.tier).toBe("LEGENDARY") // MOMENT_TIER_ stripped
    expect(legendary.source).toBe("allday")
    expect(legendary.confidenceSource).toBe("fmv_snapshots")
    const askOnly = body.deals.find((d: any) => d.playerName === "B")
    expect(askOnly.confidenceSource).toBe("ask_fallback")
  })

  it("RPC-fallback error → empty result", async () => {
    gqlEdges = []
    rpc.mockImplementation(async (name: string) => {
      if (name === "get_allday_sniper_deals") return { data: null, error: { message: "rpc down" } }
      return { data: [], error: null }
    })
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    expect(body.deals).toEqual([])
  })
})
