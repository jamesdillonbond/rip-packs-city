import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/activity (Friend Activity feed).
// Auth-gated via requireUser() → throws a 401 Response when unauthenticated;
// the handler catches it and returns it. Pin the fail-closed 401, then a
// happy path where the authed user follows nobody (follows query returns [])
// so the handler short-circuits to { activity: [] } without the sales fan-out.
//
// The sales-leg mocks are keyed on the PARENT table `sales` (not a hardcoded
// `sales_2026` partition): the feed's window is a rolling now-7d, so reading a
// fixed year partition silently returns empty once the date rolls into the next
// year. These mocks two-way-pin that — reverting the route to `sales_2026`
// makes its read miss `state.tables.sales` and fails the error/enrichment cases.

const state: { user: any; tables: Record<string, any> } = { user: null, tables: {} }

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (t: string) => chain(() => state.tables[t] ?? { data: [], error: null }),
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/activity/route"

beforeEach(() => {
  state.user = null
  state.tables = {}
})

describe("GET /api/profile/activity", () => {
  it("401s when unauthenticated (fail-closed)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns an empty feed when the authed user follows nobody", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).activity).toEqual([])
  })

  it("500s when the follows query errors", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: null, error: { message: "boom" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("boom")
  })

  it("returns an empty feed when followees track no wallets", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [{ followee_user_id: "u2" }], error: null }
    state.tables.saved_wallets = { data: [], error: null }
    state.tables.profile_bio = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).activity).toEqual([])
  })

  it("500s when the sales query errors", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [{ followee_user_id: "u2" }], error: null }
    state.tables.saved_wallets = { data: [{ user_id: "u2", wallet_addr: "0xAAA", collection_id: "c1" }], error: null }
    state.tables.profile_bio = { data: [], error: null }
    state.tables.sales = { data: null, error: { message: "sales boom" } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("sales boom")
  })

  it("returns an empty feed when no recent sales touch the tracked wallets", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [{ followee_user_id: "u2" }], error: null }
    state.tables.saved_wallets = { data: [{ user_id: "u2", wallet_addr: "0xAAA", collection_id: "c1" }], error: null }
    state.tables.profile_bio = { data: [], error: null }
    state.tables.sales = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).activity).toEqual([])
  })

  it("skips sales whose counterparties are not a tracked wallet (owner-less rows dropped)", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [{ followee_user_id: "u2" }], error: null }
    state.tables.saved_wallets = { data: [{ user_id: "u2", wallet_addr: "0xAAA", collection_id: "c1" }], error: null }
    state.tables.profile_bio = { data: [], error: null }
    // sale between two OTHER wallets → no owner match → dropped
    state.tables.sales = {
      data: [{ sold_at: "2026-07-19T00:00:00Z", collection_id: "c1", edition_id: null, seller_address: "0xZZZ", buyer_address: "0xYYY" }],
      error: null,
    }
    state.tables.editions = { data: [], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    expect((await res.json()).activity).toEqual([])
  })

  it("builds an enriched item when a tracked wallet is the seller (edition + bio joined, case-insensitive)", async () => {
    state.user = { id: "u1" }
    state.tables.follows = { data: [{ followee_user_id: "u2" }], error: null }
    state.tables.saved_wallets = { data: [{ user_id: "u2", wallet_addr: "0xAAA", collection_id: "c1" }], error: null }
    state.tables.profile_bio = { data: [{ user_id: "u2", username: "friend", display_name: "Friend" }], error: null }
    state.tables.sales = {
      data: [{
        sold_at: "2026-07-19T00:00:00Z",
        price_usd: 42,
        collection_id: "c1",
        edition_id: "e1",
        moment_id: "m1",
        seller_address: "0xaaa", // lower-case form still matches the 0xAAA tracked wallet
        buyer_address: "0xBBB",
        serial_number: 7,
      }],
      error: null,
    }
    state.tables.editions = {
      data: [{ id: "e1", player_name: "Luka Doncic", set_name: "Base", tier: "COMMON", thumbnail_url: "http://x/y.png" }],
      error: null,
    }
    const res = await GET()
    expect(res.status).toBe(200)
    const { activity } = await res.json()
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({
      followee_username: "friend",
      followee_display_name: "Friend",
      role: "seller",
      wallet_addr: "0xaaa",
      collection_id: "c1",
      player_name: "Luka Doncic",
      set_name: "Base",
      tier: "COMMON",
      serial_number: 7,
      price_usd: 42,
    })
  })
})
