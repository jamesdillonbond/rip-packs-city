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

vi.mock("@/lib/cache", () => ({ getOrSetCache: async (_k: string, _t: number, fn: any) => fn(), deleteCache: () => {} }))

const st = vi.hoisted(() => ({
  fmv: { data: [] as any[], error: null as any },
  editions: { data: [] as any[], error: null as any },
}))
const rpc = vi.hoisted(() =>
  // Explicit `Promise<any>`: without it the empty default narrows data to
  // `never[]`, so mockImplementation returning real rows fails to typecheck.
  vi.fn(async (_name: string, _params?: any): Promise<any> => ({ data: [], error: null })),
)
// The FMV map reads `fmv_current` (DISTINCT ON latest, <=1 row/edition) and pages
// it with .range() — 6,190 live AD rows exceed PostgREST's 1000-row cap. The mock
// is range-AWARE (it slices st.fmv.data) so the paging loop is actually driven
// rather than short-circuited, and st.pages records the windows requested.
const st2 = vi.hoisted(() => ({ pages: [] as Array<[number, number]> }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from(table: string) {
      let range: [number, number] | null = null
      const b: any = {
        select: () => b, eq: () => b, order: () => b, in: () => b, gt: () => b,
        range: (from: number, to: number) => {
          range = [from, to]
          if (table === "fmv_current") st2.pages.push([from, to])
          return b
        },
        then: (resolve: any) => {
          if (table === "fmv_current") {
            if (st.fmv.error) return resolve({ data: null, error: st.fmv.error })
            const rows = st.fmv.data
            return resolve(range ? { data: rows.slice(range[0], range[1] + 1), error: null } : st.fmv)
          }
          return resolve(table === "editions" ? st.editions : { data: [], error: null })
        },
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
  st2.pages = []
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

  // 2026-07-25 — was: "no FMV entry → ask-fallback confidence, 0 discount
  // (askPrice == baseFmv)". buildDeal used `fmvEntry?.fmv || askPrice`, so a
  // listing with no FMV shipped with baseFmv == askPrice and a fake 0%
  // discount. Borrowing the ask fabricates a fair value; the row is dropped now.
  it("no FMV entry → row is EXCLUDED (never borrows the ask as FMV)", async () => {
    gqlEdges = [node()] // no fmv/editions rows → fmvMap empty
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    expect(body.deals).toEqual([])
  })

  it("fmv_snapshots row with a NULL fmv_usd → row is EXCLUDED, not $0.00 and not the ask", async () => {
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: null, confidence: "LOW", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
    // NOTE: the mock does not implement the route's server-side `.gt("fmv_usd",0)`
    // filter, so this NULL actually reaches the map — which is the point: it
    // exercises buildDeal's OWN guard, the second layer. The old
    // `Number(null) || 0` + `|| askPrice` combination produced a row labelled
    // confidenceSource "fmv_snapshots" with baseFmv == askPrice (60).
    expect(body.deals.some((d: any) => d.baseFmv === 0 || d.baseFmv === 60)).toBe(false)
  })

  it("fmv_snapshots row with fmv_usd 0 → row is EXCLUDED (never a $0.00 fair value)", async () => {
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 0, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]
    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(0)
  })

  it("#1-serial and Jersey-serial specials add extra deals", async () => {
    // Needs a real FMV: since 2026-07-25 a listing with no FMV is excluded
    // outright rather than shipped with baseFmv borrowed from the ask.
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
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

  // ── PostgREST 1000-row cap (2026-07-25) ──────────────────────────────────
  // The FMV map used to read raw fmv_snapshots `.eq(collection).order(DESC)`
  // with NO bound, on the belief that AD had "~341 rows". Live it is 306,895
  // snapshot rows over 6,190 editions, so PostgREST's cap meant the map only
  // ever held a few hundred editions — and once a missing FMV EXCLUDES a row,
  // a truncated map silently drops most of the board. Now it reads fmv_current
  // (<=1 row/edition) and pages with .range().
  it("pages fmv_current past the 1000-row cap so a high-offset edition still prices", async () => {
    // 1,500 editions: the target sits at index 1,200, i.e. only reachable on the
    // SECOND page. Under the old single unbounded read it was invisible.
    const rows = Array.from({ length: 1500 }, (_, i) => ({
      edition_id: `E${i}`, fmv_usd: 100, confidence: "HIGH",
    }))
    rows[1200] = { edition_id: "TARGET", fmv_usd: 250, confidence: "HIGH" }
    st.fmv = { data: rows, error: null }
    st.editions = { data: [{ id: "TARGET", external_id: "555" }], error: null }
    gqlEdges = [node()]

    const body = await (await GET(get(ADQS))).json()
    expect(body.count).toBe(1)
    expect(body.deals[0].baseFmv).toBe(250) // priced off page 2
    expect(body.deals[0].discount).toBe(76) // (250-60)/250
    // two full pages + a short third page that ends the loop
    expect(st2.pages.length).toBeGreaterThanOrEqual(2)
    expect(st2.pages[0]).toEqual([0, 999])
    expect(st2.pages[1]).toEqual([1000, 1999])
  })

  it("stops paging and degrades (no throw) when a page read errors", async () => {
    st.fmv = { data: [], error: { message: "fmv_current down" } }
    st.editions = { data: [{ id: "E1", external_id: "555" }], error: null }
    gqlEdges = [node()]
    const res = await GET(get(ADQS))
    expect(res.status).toBe(200) // degrades to an unpriced (therefore empty) feed
    expect((await res.json()).count).toBe(0)
    expect(st2.pages.length).toBe(1) // broke out after the first failed page
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
            { flow_id: "f3", moment_id: "m3", tier: "COMMON", confidence: "ASK_ONLY", player_name: "C", ask_price: 12, fmv_usd: null, discount_pct: 0 },
          ],
          error: null,
        }
      }
      return { data: [], error: null }
    })

    const body = await (await GET(get(ADQS))).json()
    // 2026-07-25: rows B (fmv_usd 0) and C (fmv_usd NULL) are dropped — the old
    // mapping emitted them with baseFmv/adjustedFmv 0, i.e. a literal $0.00
    // fair value on the board.
    expect(body.count).toBe(1)
    expect(body.flowtyCount).toBe(1)
    const legendary = body.deals.find((d: any) => d.playerName === "A")
    expect(legendary.tier).toBe("LEGENDARY") // MOMENT_TIER_ stripped
    expect(legendary.source).toBe("allday")
    expect(legendary.confidenceSource).toBe("fmv_snapshots")
    expect(body.deals.some((d: any) => d.playerName === "B" || d.playerName === "C")).toBe(false)
    expect(body.deals.every((d: any) => d.baseFmv > 0)).toBe(true)
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
