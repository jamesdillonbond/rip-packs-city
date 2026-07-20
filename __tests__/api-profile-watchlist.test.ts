import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/watchlist. Public ownerKey-keyed
// (owner_key text, no session gate — see CLAUDE.md "Deferred hardening"), so
// guards are param-based. Covers the param 400s, the GET enrichment path
// (edition join + DISTINCT-ON-latest FMV/floor + below_target), the write/delete
// success + error paths, and the best-effort rewards hook (must never break the
// write). The supabase mock is table-aware so the three GET reads
// (watchlist_items / editions / fmv_current) return distinct fixtures.

const state: {
  tables: Record<string, { data: any; error: any }>
  single: { data: any; error: any }
  rewardsUser: any
  awardCalls: string[]
} = { tables: {}, single: { data: null, error: null }, rewardsUser: null, awardCalls: [] }

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    const b: any = {
      select: () => b,
      upsert: () => b,
      delete: () => b,
      eq: () => b,
      in: () => b,
      order: () => b,
      single: async () => state.single,
      then: (resolve: any) => resolve(state.tables[table] ?? { data: [], error: null }),
    }
    return b
  }
  const client: any = { from: (t: string) => chainFor(t), rpc: async () => ({ data: null, error: null }) }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.rewardsUser,
}))

vi.mock("@/lib/rewards", () => ({
  awardPoints: async (userId: string, action: string) => {
    state.awardCalls.push(`${userId}:${action}`)
  },
}))

import { GET, POST, DELETE } from "@/app/api/profile/watchlist/route"

const req = (url: string, body?: any) => ({ nextUrl: new URL(url), json: async () => body }) as any

beforeEach(() => {
  state.tables = {}
  state.single = { data: null, error: null }
  state.rewardsUser = null
  state.awardCalls = []
})

describe("GET /api/profile/watchlist", () => {
  it("400s without ownerKey", async () => {
    const res = await GET(req("https://t/api/profile/watchlist"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("returns items on the happy path with no editions to enrich", async () => {
    state.tables.watchlist_items = { data: [], error: null }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })

  it("500s when the watchlist read errors", async () => {
    state.tables.watchlist_items = { data: null, error: { message: "wl boom" } }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=trevor"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("wl boom")
  })

  it("enriches with edition fields, latest FMV/floor, and below_target", async () => {
    state.tables.watchlist_items = {
      data: [{ id: "w1", owner_key: "trevor", edition_id: "e1", target_price: "10", notes: "watch", created_at: "2026-07-01" }],
      error: null,
    }
    state.tables.editions = {
      data: [{ id: "e1", player_name: "Luka Doncic", set_name: "Base", tier: "RARE" }],
      error: null,
    }
    // Two rows for e1; DESC order → the first is latest and wins the map.
    // (fmv_current is DISTINCT-ON-latest in prod; the mock over-supplies to
    // prove the dedup loop still keeps the first row.)
    state.tables.fmv_current = {
      data: [
        { edition_id: "e1", fmv_usd: 20, floor_price_usd: 8, computed_at: "2026-07-02" },
        { edition_id: "e1", fmv_usd: 999, floor_price_usd: 999, computed_at: "2026-06-01" },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const { items } = await res.json()
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "w1",
      edition_id: "e1",
      player_name: "Luka Doncic",
      set_name: "Base",
      tier: "RARE",
      target_price: 10,
      current_fmv: 20, // latest snapshot, not the stale 999
      current_ask: 8,
      below_target: true, // ask 8 <= target 10
    })
  })

  it("below_target is false when the floor is above the target", async () => {
    state.tables.watchlist_items = {
      data: [{ id: "w1", owner_key: "t", edition_id: "e1", target_price: "5", notes: null, created_at: "x" }],
      error: null,
    }
    state.tables.editions = { data: [{ id: "e1", player_name: "P", set_name: "S", tier: "COMMON" }], error: null }
    state.tables.fmv_current = { data: [{ edition_id: "e1", fmv_usd: 30, floor_price_usd: 40, computed_at: "y" }], error: null }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=t"))
    const { items } = await res.json()
    expect(items[0].below_target).toBe(false)
    expect(items[0].current_ask).toBe(40)
  })
})

describe("POST /api/profile/watchlist", () => {
  it("400s without ownerKey and editionId", async () => {
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey and editionId required")
  })

  it("upserts and returns the item on success", async () => {
    state.single = { data: { id: "w9", edition_id: "e1" }, error: null }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor", editionId: "e1", targetPrice: 12, notes: "n" }))
    expect(res.status).toBe(200)
    expect((await res.json()).item).toMatchObject({ id: "w9" })
  })

  it("awards points when a logged-in user adds an item (best-effort)", async () => {
    state.single = { data: { id: "w9" }, error: null }
    state.rewardsUser = { id: "u1" }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor", editionId: "e1" }))
    expect(res.status).toBe(200)
    expect(state.awardCalls).toContain("u1:add_watchlist_item")
  })

  it("500s when the upsert errors", async () => {
    state.single = { data: null, error: { message: "upsert boom" } }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor", editionId: "e1" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("upsert boom")
  })
})

describe("DELETE /api/profile/watchlist", () => {
  it("400s without ownerKey and itemId", async () => {
    const res = await DELETE(req("https://t/api/profile/watchlist", { ownerKey: "trevor" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey and itemId required")
  })

  it("deletes on success (body args)", async () => {
    state.tables.watchlist_items = { data: null, error: null }
    const res = await DELETE(req("https://t/api/profile/watchlist", { ownerKey: "trevor", itemId: "w1" }))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("accepts ownerKey/itemId from query params too", async () => {
    state.tables.watchlist_items = { data: null, error: null }
    const res = await DELETE(req("https://t/api/profile/watchlist?ownerKey=trevor&itemId=w1"))
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it("500s when the delete errors", async () => {
    state.tables.watchlist_items = { data: null, error: { message: "del boom" } }
    const res = await DELETE(req("https://t/api/profile/watchlist", { ownerKey: "trevor", itemId: "w1" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("del boom")
  })
})
