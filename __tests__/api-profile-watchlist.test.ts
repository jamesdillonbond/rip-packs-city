import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/watchlist. A watchlist is PRIVATE and
// owner_key-keyed, and every verb is a service-role query whose row selector
// came from the request — so as of the owner-key IDOR fix all three verbs run
// `requireOwnedKey(ownerKey)` before touching the DB. Covers the param 400s, the
// GET enrichment path (edition join + DISTINCT-ON-latest FMV/floor +
// below_target), the write/delete success + error paths, the rewards hook (now
// keyed off the GUARDED session user, so points can never be attributed to
// someone else), and the ownership contract itself (401 unauthenticated / 403
// cross-user on GET, POST and DELETE — the IDOR that was closed).
//
// The supabase mock is table-aware so the three GET reads (watchlist_items /
// editions / fmv_current) return distinct fixtures, and so `profile_bio` can
// answer the guard's two ownership lookups.

const state: {
  tables: Record<string, { data: any[] | any | null; error: any | null }>
  single: { data: any | null; error: any | null }
  awardCalls: string[]
} = { tables: {}, single: { data: null, error: null }, awardCalls: [] }

// ── requireOwnedKey fixtures ────────────────────────────────────────────────
// The guard demands a session AND that `profile_bio` prove the key belongs to
// that session user. `ownership.claimantId` is who claims the requested key
// (null = unclaimed); the claimed username echoes back whatever key the route
// asked about, so any ownerKey a test uses resolves to the caller unless the
// test overrides it. `selfUsername` drives the unclaimed-key branch (a caller
// who already owns a username may not write unclaimed keys).
const auth: { user: { id: string } | null } = { user: { id: "u1" } }
const ownership: {
  claimantId: string | null
  claimantErr: any | null
  selfUsername: string | null
  selfErr: any | null
} = { claimantId: "u1", claimantErr: null, selfUsername: null, selfErr: null }

// profile_bio is read twice by the guard: `.ilike("username", key)` (who claims
// the key) and `.eq("user_id", …)` (does the caller have a username of their
// own). Distinguish the two by which filter was used.
function profileBioBuilder() {
  let claimQuery = false
  let key = ""
  const b: any = {
    select: () => b,
    ilike: (_col: string, v: string) => {
      claimQuery = true
      key = v
      return b
    },
    eq: () => b,
    maybeSingle: async (): Promise<{ data: any | null; error: any | null }> =>
      claimQuery
        ? {
            data: ownership.claimantId
              ? { user_id: ownership.claimantId, username: key }
              : null,
            error: ownership.claimantErr,
          }
        : {
            data: ownership.selfUsername ? { username: ownership.selfUsername } : null,
            error: ownership.selfErr,
          },
  }
  return b
}

vi.mock("@/lib/supabase", () => {
  const chainFor = (table: string) => {
    if (table === "profile_bio") return profileBioBuilder()
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
  getCurrentUser: async () => auth.user,
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
  state.awardCalls = []
  auth.user = { id: "u1" }
  ownership.claimantId = "u1"
  ownership.claimantErr = null
  ownership.selfUsername = null
  ownership.selfErr = null
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
    expect((await res.json()).error).not.toContain("wl boom")
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

  it("awards points to the GUARDED session user when an item is added (best-effort)", async () => {
    state.single = { data: { id: "w9" }, error: null }
    auth.user = { id: "u1" }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor", editionId: "e1" }))
    expect(res.status).toBe(200)
    expect(state.awardCalls).toContain("u1:add_watchlist_item")
  })

  it("500s when the upsert errors", async () => {
    state.single = { data: null, error: { message: "upsert boom" } }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor", editionId: "e1" }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain("upsert boom")
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
    expect((await res.json()).error).not.toContain("del boom")
  })
})

// ── the ownership contract (the IDOR that was closed) ───────────────────────
// A watchlist is private. Before the guard, `owner_key` WAS the authorization
// decision on a service-role query, so anyone could read, add to, or delete out
// of another user's watchlist by supplying their public username. These pin
// both halves of the fix on every verb.
describe("/api/profile/watchlist — ownership guard", () => {
  it("GET 401s when unauthenticated, before reading the watchlist", async () => {
    auth.user = null
    state.tables.watchlist_items = { data: [{ id: "secret" }], error: null }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=victim"))
    expect(res.status).toBe(401)
  })

  it("GET 403s when ownerKey is claimed by a DIFFERENT user", async () => {
    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    state.tables.watchlist_items = { data: [{ id: "secret" }], error: null }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=victim"))
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain("secret")
  })

  it("POST 401s when unauthenticated and awards nothing", async () => {
    auth.user = null
    state.single = { data: { id: "w9" }, error: null }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "victim", editionId: "e1" }))
    expect(res.status).toBe(401)
    expect(state.awardCalls).toEqual([])
  })

  it("POST 403s when ownerKey is claimed by a DIFFERENT user", async () => {
    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    state.single = { data: { id: "w9" }, error: null }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "victim", editionId: "e1" }))
    expect(res.status).toBe(403)
    expect(state.awardCalls).toEqual([])
  })

  it("DELETE 401s when unauthenticated", async () => {
    auth.user = null
    state.tables.watchlist_items = { data: null, error: null }
    const res = await DELETE(req("https://t/api/profile/watchlist", { ownerKey: "victim", itemId: "w1" }))
    expect(res.status).toBe(401)
  })

  it("DELETE 403s when ownerKey is claimed by a DIFFERENT user", async () => {
    auth.user = { id: "attacker" }
    ownership.claimantId = "victim"
    state.tables.watchlist_items = { data: null, error: null }
    const res = await DELETE(req("https://t/api/profile/watchlist", { ownerKey: "victim", itemId: "w1" }))
    expect(res.status).toBe(403)
  })

  it("allows a brand-new account (no username yet) to write an UNCLAIMED key", async () => {
    ownership.claimantId = null // nobody claims it
    ownership.selfUsername = null // and the caller has no username of their own
    state.single = { data: { id: "w9" }, error: null }
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "fresh-key", editionId: "e1" }))
    expect(res.status).toBe(200)
  })

  it("403s an UNCLAIMED key when the caller already owns a username", async () => {
    ownership.claimantId = null
    ownership.selfUsername = "trevor" // caller has their own key; this isn't it
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "someone-elses", editionId: "e1" }))
    expect(res.status).toBe(403)
  })

  it("fails CLOSED with 403 when the ownership lookup itself errors", async () => {
    ownership.claimantErr = { message: "profile_bio unavailable" }
    state.tables.watchlist_items = { data: [{ id: "secret" }], error: null }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=trevor"))
    expect(res.status).toBe(403)
  })
})
