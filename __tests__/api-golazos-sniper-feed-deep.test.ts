import { describe, it, expect, beforeEach, vi } from "vitest"

// Deep drive of GET /api/golazos-sniper-feed (the sibling test only pins the empty
// shape). This synchronous route reads cached_listings → joins editions (by
// player|set) → joins fmv_snapshots (latest per edition) → shapes SniperDeals with
// a computed discount, then filters by ask>0 / minDiscount and slices to limit.
// The legs pinned: the listings-query error → 500, the FMV-join discount math, the
// tier query param, the minDiscount + ask>0 filters, the limit slice, and the
// no-player/set (empty-key) fallback. Backed by a chainable Supabase builder.

const st = vi.hoisted(() => ({
  listings: { data: [] as any[], error: null as any },
  editions: { data: [] as any[], error: null as any },
  fmv: { data: [] as any[], error: null as any },
}))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from(table: string) {
      const b: any = {}
      for (const m of ["select", "eq", "gt", "order", "limit", "in"]) b[m] = () => b
      b.then = (resolve: any) =>
        resolve(table === "cached_listings" ? st.listings : table === "editions" ? st.editions : table === "fmv_snapshots" ? st.fmv : { data: [], error: null })
      return b
    },
  }),
}))

import { GET } from "@/app/api/golazos-sniper-feed/route"

const get = (qs = "") => ({ nextUrl: new URL(`https://t/api/golazos-sniper-feed${qs}`) }) as any

beforeEach(() => {
  st.listings = { data: [], error: null }
  st.editions = { data: [], error: null }
  st.fmv = { data: [], error: null }
})

const listing = (over: any = {}) => ({
  flow_id: "f1", moment_id: "m1", player_name: "Messi", set_name: "S1",
  team_name: "Barcelona", tier: "rare", ask_price: 60, serial_number: 5,
  listed_at: "2026-01-01", ...over,
})

describe("GET /api/golazos-sniper-feed", () => {
  it("listings-query error → 500", async () => {
    st.listings = { data: null, error: { message: "cached_listings down" } }
    const res = await GET(get())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("cached_listings down")
  })

  it("empty listings → count 0, flowtyCount 0", async () => {
    const body = await (await GET(get())).json()
    expect(body.count).toBe(0)
    expect(body.tsCount).toBe(0)
    expect(body.deals).toEqual([])
  })

  it("joins editions+fmv and computes the discount", async () => {
    st.listings = { data: [listing()], error: null }
    st.editions = { data: [{ id: "E1", player_name: "Messi", set_name: "S1", circulation_count: 100, series: 1, tier: "RARE" }], error: null }
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }

    const body = await (await GET(get())).json()
    expect(body.count).toBe(1)
    const d = body.deals[0]
    expect(d.editionKey).toBe("E1")
    expect(d.baseFmv).toBe(100)
    expect(d.discount).toBe(40) // (100-60)/100
    expect(d.tier).toBe("RARE")
    expect(d.source).toBe("flowty")
    expect(d.paymentToken).toBe("DUC")
  })

  it("minDiscount filters out deals below the threshold", async () => {
    st.listings = { data: [listing()], error: null }
    st.editions = { data: [{ id: "E1", player_name: "Messi", set_name: "S1", circulation_count: 100, series: 1, tier: "RARE" }], error: null }
    st.fmv = { data: [{ edition_id: "E1", fmv_usd: 100, confidence: "HIGH", computed_at: "2026-01-01" }], error: null }

    const body = await (await GET(get("?minDiscount=50"))).json() // deal discount 40 < 50
    expect(body.count).toBe(0)
  })

  it("a valid tier query param is applied (branch) and still returns", async () => {
    st.listings = { data: [listing()], error: null }
    const body = await (await GET(get("?tier=RARE"))).json()
    expect(body.count).toBe(1)
  })

  it("ask_price 0 rows are dropped; limit slices the result", async () => {
    st.listings = {
      data: [listing({ flow_id: "a", ask_price: 10 }), listing({ flow_id: "b", ask_price: 0 }), listing({ flow_id: "c", ask_price: 20 })],
      error: null,
    }
    const body = await (await GET(get("?limit=1"))).json()
    expect(body.count).toBe(1) // ask 0 dropped, then sliced to 1
  })

  it("a listing with no player/set falls back to empty edition key, baseFmv 0", async () => {
    st.listings = { data: [listing({ player_name: null, set_name: null, ask_price: 30 })], error: null }
    const body = await (await GET(get())).json()
    expect(body.count).toBe(1)
    expect(body.deals[0].editionKey).toBe("")
    expect(body.deals[0].baseFmv).toBe(0)
    expect(body.deals[0].discount).toBe(0)
  })
})
