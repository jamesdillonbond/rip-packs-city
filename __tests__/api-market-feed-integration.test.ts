import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { NextRequest } from "next/server"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Route-integration test for GET /api/market-feed driving the REAL body:
// auth gate, loadEditionKeysFromSupabase, the per-set Top Shot GQL stats fetch
// (fetchStatsForEditions), and the assembled EditionStats response. The GQL seam
// is @/lib/topshot.topshotGraphql (mocked); the DB seam is supabaseAdmin
// (makeSupabaseFixture). The seller-concentration block is skipped by returning
// no seller_address column from the query_sql probe.

const fx = vi.hoisted(() => ({
  tables: {} as Record<string, { data?: unknown; error?: unknown } | Array<{ data?: unknown; error?: unknown }>>,
  gql: null as any,
  // When true, topshotGraphql rejects — drives the per-set catch in fetchStatsForEditions.
  gqlThrow: false,
}))

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: makeSupabaseFixture(fx.tables) }))
vi.mock("@/lib/chains/flow/topshot", () => ({
  topshotGraphql: async () => {
    if (fx.gqlThrow) throw new Error("topshot proxy 502")
    return fx.gql
  },
}))

const { GET, POST } = await import("@/app/api/market-feed/route")

function get(qs = "") {
  return new NextRequest(`https://t/api/market-feed${qs}`)
}

// supabaseAdmin is a singleton bound to fx.tables at mock-init, so mutate the
// object in place rather than reassigning it (a new ref wouldn't be seen).
beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  fx.gql = null
  fx.gqlThrow = false
  delete process.env.CRON_SECRET
  delete process.env.MARKET_FEED_TOKEN
})
afterEach(() => {
  delete process.env.CRON_SECRET
  delete process.env.MARKET_FEED_TOKEN
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
      // query_sql seller_address column probe -> no column -> concentration skipped
      "rpc:query_sql": { data: [] },
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

// ---------------------------------------------------------------------------
// Authorization matrix (isAuthorized) beyond the single 401 above.
// ---------------------------------------------------------------------------
describe("GET /api/market-feed — authorization", () => {
  it("passes with a valid Bearer CRON_SECRET", async () => {
    process.env.CRON_SECRET = "cron-secret"
    Object.assign(fx.tables, { editions: { data: [] } })
    const req = new NextRequest("https://t/api/market-feed", {
      headers: { authorization: "Bearer cron-secret" },
    })
    const res = await GET(req)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("passes with a matching ?token=MARKET_FEED_TOKEN", async () => {
    process.env.MARKET_FEED_TOKEN = "feed-token"
    Object.assign(fx.tables, { editions: { data: [] } })
    const res = await GET(get("?token=feed-token"))
    expect(res.status).toBe(200)
  })

  it("401s when a token is configured but the supplied ?token is wrong", async () => {
    process.env.MARKET_FEED_TOKEN = "feed-token"
    const res = await GET(get("?token=nope"))
    expect(res.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// loadEditionKeysFromSupabase + fetchStatsForEditions edge branches.
// ---------------------------------------------------------------------------
describe("GET /api/market-feed — key loading + stats fan-out", () => {
  it("returns [] when the editions read errors (Supabase error branch)", async () => {
    Object.assign(fx.tables, { editions: { data: null, error: { message: "db down" } } })
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("drops edition keys with no ':' and skips malformed set:play keys", async () => {
    // "9" has no ':' (filtered in JS); "1:2:3" splits to 3 parts (skipped in fan-out);
    // only "1:2" survives to a stats row.
    Object.assign(fx.tables, {
      editions: { data: [{ external_id: "9" }, { external_id: "1:2:3" }, { external_id: "1:2" }] },
      "rpc:query_sql": { data: [] },
    })
    fx.gql = {
      searchEditions: {
        data: [{ set: { id: "1" }, play: { id: "2" }, stats: { lowestAsk: null, averagePrice: null, totalSales: 0 } }],
      },
    }
    const body = await (await GET(get())).json()
    // "9" never reaches fetchStatsForEditions; "1:2:3" is skipped by the parts.length guard.
    expect(body).toHaveLength(1)
    expect(body[0].editionKey).toBe("1:2")
    // null lowestAsk => askCount 0 branch
    expect(body[0].lowAsk).toBeNull()
    expect(body[0].askCount).toBe(0)
  })

  it("survives a per-set GQL failure without stats for that set (non-fatal catch)", async () => {
    Object.assign(fx.tables, {
      editions: { data: [{ external_id: "1:2" }] },
      "rpc:query_sql": { data: [] },
    })
    fx.gqlThrow = true
    const res = await GET(get())
    expect(res.status).toBe(200)
    // the set's GQL threw -> its editions never got a stats entry -> empty feed
    expect(await res.json()).toEqual([])
  })
})

describe("POST /api/market-feed", () => {
  it("is aliased to GET and returns the same [] on an empty catalog", async () => {
    Object.assign(fx.tables, { editions: { data: [] } })
    const res = await POST(get())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// The seller-concentration block. It is guarded by a column probe, so with the
// probe returning [] (above) the whole thing is skipped and stays dark. These
// drive the probe-positive path: the concentration query, the pct thresholds
// (>0.6 high, >0.4 medium, else low), the edition-id -> external-key remap, and
// the non-fatal catch that must never take the whole feed down.
// ---------------------------------------------------------------------------

describe("GET /api/market-feed — seller concentration", () => {
  const GQL_ONE = {
    searchEditions: {
      data: [{ set: { id: "1" }, play: { id: "2" }, stats: { lowestAsk: 5, averagePrice: 4, totalSales: 3 } }],
    },
  }

  // query_sql is called twice: [0] the seller_address column probe,
  // [1] the concentration aggregate. The fixture is sequence-aware.
  function withConcentration(total: number, top3: number) {
    Object.assign(fx.tables, {
      editions: [
        { data: [{ external_id: "1:2" }] },          // loadEditionKeysFromSupabase
        { data: [{ id: "ed-uuid", external_id: "1:2" }] }, // the id -> external remap
      ],
      "rpc:query_sql": [
        { data: [{ column_name: "seller_address" }] },
        { data: [{ edition_id: "ed-uuid", total, top3_count: top3 }] },
      ],
    })
    fx.gql = GQL_ONE
  }

  it("tags an edition 'high' when the top-3 sellers hold >60% of listings", async () => {
    withConcentration(10, 7)
    const body = await (await GET(get())).json()
    expect(body[0].sellerConcentration).toBe("high")
  })

  it("tags 'medium' between 40% and 60%", async () => {
    withConcentration(10, 5)
    const body = await (await GET(get())).json()
    expect(body[0].sellerConcentration).toBe("medium")
  })

  it("tags 'low' at or below 40%", async () => {
    withConcentration(10, 3)
    const body = await (await GET(get())).json()
    expect(body[0].sellerConcentration).toBe("low")
  })

  it("still returns the feed when the concentration query yields nothing", async () => {
    Object.assign(fx.tables, {
      editions: { data: [{ external_id: "1:2" }] },
      "rpc:query_sql": [
        { data: [{ column_name: "seller_address" }] },
        { data: [] },
      ],
    })
    fx.gql = GQL_ONE
    const res = await GET(get())
    expect(res.status).toBe(200)
    expect((await res.json())[0].editionKey).toBe("1:2")
  })

  it("a concentration failure is NON-FATAL — the feed still returns", async () => {
    Object.assign(fx.tables, {
      editions: { data: [{ external_id: "1:2" }] },
      "rpc:query_sql": { data: null, error: { message: "query_sql denied" } },
    })
    fx.gql = GQL_ONE
    const res = await GET(get())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].sellerConcentration ?? null).toBeNull()
  })

  it("sets the shared browser/CDN cache headers on the populated feed", async () => {
    Object.assign(fx.tables, {
      editions: { data: [{ external_id: "1:2" }] },
      "rpc:query_sql": { data: [] },
    })
    fx.gql = GQL_ONE
    const res = await GET(get())
    expect(res.headers.get("Cache-Control")).toContain("max-age=120")
  })
})
