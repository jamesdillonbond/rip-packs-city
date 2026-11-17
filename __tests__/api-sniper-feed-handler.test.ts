import { describe, it, expect, beforeEach, vi } from "vitest"

// Drives GET /api/sniper-feed's HANDLER CONTRACT — the orchestration layer around
// the (separately-tested) compute functions: collection-alias mapping, the 4-way
// compute dispatch, applyOuterFilters (editionKey / intEditionKey, player substring,
// flowWalletOnly payment-token), the limit slice, the response envelope, and the
// error→500 path. The deep TopShot/AllDay GQL fan-out has its own fixtures; here we
// mock the getOrSetCache seam to return a canned feed so the filter/shape/dispatch
// branches (unreachable when the live pool is empty) are exercised directly.

const st = vi.hoisted(() => ({
  result: null as any,
  shouldThrow: false,
  lastKey: "" as string,
  deleted: [] as string[],
}))
vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (key: string, _ttl: number, _fn: any) => {
    st.lastKey = key
    if (st.shouldThrow) throw new Error("compute exploded")
    return st.result
  },
  deleteCache: (key: string) => { st.deleted.push(key) },
}))

import { GET } from "@/app/api/sniper-feed/route"

const get = (qs: string) => new Request(`https://t/api/sniper-feed${qs}`)

// Minimal SniperDeal-ish objects carrying only the fields the handler reads.
const deal = (over: Partial<any> = {}): any => ({
  editionKey: "1:2",
  intEditionKey: "1:2",
  playerName: "Stephen Curry",
  paymentToken: "FLOW",
  ...over,
})
const feed = (deals: any[]): any => ({
  count: deals.length,
  tsCount: deals.length,
  flowtyCount: 0,
  lastRefreshed: "2026-07-25T00:00:00.000Z",
  deals,
})

beforeEach(() => {
  st.result = feed([deal()])
  st.shouldThrow = false
  st.lastKey = ""
  st.deleted = []
})

describe("GET /api/sniper-feed — handler contract", () => {
  it("returns the feed with marketplaceAvailability and a recomputed count", async () => {
    st.result = feed([deal({ editionKey: "1:2" }), deal({ editionKey: "3:4", intEditionKey: "3:4" })])
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.deals).toHaveLength(2)
    expect(body.marketplaceAvailability).toEqual({ topshot: true, flowty: false })
    expect(res.headers.get("Cache-Control")).toContain("s-maxage=90")
  })

  it("editionKey filter matches on editionKey OR intEditionKey", async () => {
    st.result = feed([
      deal({ editionKey: "1:2", intEditionKey: "aaa" }),
      deal({ editionKey: "zzz", intEditionKey: "1:2" }), // matches via intEditionKey
      deal({ editionKey: "9:9", intEditionKey: "8:8" }), // no match
    ])
    const body = await (await GET(get("?collection=nba-top-shot&editionKey=1:2"))).json()
    expect(body.count).toBe(2)
  })

  it("player filter is a case-insensitive substring on playerName", async () => {
    st.result = feed([
      deal({ playerName: "Stephen Curry" }),
      deal({ playerName: "LeBron James" }),
    ])
    const body = await (await GET(get("?collection=nba-top-shot&player=curry"))).json()
    expect(body.count).toBe(1)
    expect(body.deals[0].playerName).toBe("Stephen Curry")
  })

  it("flowWalletOnly keeps FLOW / USDC_E and drops other payment tokens", async () => {
    st.result = feed([
      deal({ paymentToken: "FLOW" }),
      deal({ paymentToken: "USDC_E" }),
      deal({ paymentToken: "DUC" }),
    ])
    const body = await (await GET(get("?collection=nba-top-shot&flowWalletOnly=true"))).json()
    expect(body.count).toBe(2)
    expect(body.deals.every((d: any) => d.paymentToken === "FLOW" || d.paymentToken === "USDC_E")).toBe(true)
  })

  it("limit slices the final deal list", async () => {
    st.result = feed([deal({ editionKey: "a" }), deal({ editionKey: "b" }), deal({ editionKey: "c" })])
    const body = await (await GET(get("?collection=nba-top-shot&limit=2"))).json()
    expect(body.count).toBe(2)
    expect(body.deals).toHaveLength(2)
  })

  it("underscored collection aliases resolve (nba_top_shot, pinnacle)", async () => {
    expect((await GET(get("?collection=nba_top_shot"))).status).toBe(200)
    expect((await GET(get("?collection=pinnacle"))).status).toBe(200)
  })

  it("dispatches each collection branch without error (allday / pinnacle / other / topshot)", async () => {
    for (const c of ["nfl-all-day", "disney-pinnacle", "laliga-golazos", "ufc", "nba-top-shot"]) {
      const res = await GET(get(`?collection=${c}`))
      expect(res.status).toBe(200)
    }
  })

  it("a compute/cache throw is caught → 500 'Feed unavailable' with an empty deal list", async () => {
    st.shouldThrow = true
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).toBe("Feed unavailable")
    expect(body.deals).toEqual([])
    expect(body.count).toBe(0)
    expect(body.marketplaceAvailability).toEqual({ topshot: true, flowty: false })
  })

  it("the cache key varies with the query params", async () => {
    await GET(get("?collection=nba-top-shot&player=curry"))
    const k1 = st.lastKey
    await GET(get("?collection=nba-top-shot&player=lebron"))
    expect(st.lastKey).not.toBe(k1)
  })
})
