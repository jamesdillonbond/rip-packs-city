import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/watchlist. The route builds its own client via
// createClient(@supabase/supabase-js), so data paths mock THAT (not
// @/lib/supabase). GET fans out across watchlist/editions/fmv_current/
// badge_editions/fmv_alerts — a per-table builder returns fixtures keyed by
// table; POST upserts (single) → 201; DELETE scopes by (owner_key, edition_key).
//
// All three verbs are session-gated as of the owner-key IDOR fix: a watchlist
// (and its fmv_alerts join) is PRIVATE, and `owner_key` used to BE the
// authorization decision on a service-role query. `requireOwnedKey` lives in
// @/lib/auth/owner-key-guard and reads `profile_bio` through the SHARED
// supabaseAdmin client, so this file mocks @/lib/supabase too — even though the
// route itself never uses it.

const state: { user: any | null; tables: Record<string, any>; single: { data: any | null; error: any | null } } = {
  user: null,
  tables: {},
  single: { data: null, error: null },
}

// ── requireOwnedKey fixtures ────────────────────────────────────────────────
// `ownership.claimantId` is who claims the requested key (null = unclaimed); the
// claimed username echoes back whatever key the route asked about, so any
// owner_key a test uses resolves to the caller unless the test overrides it.
// `selfUsername` drives the unclaimed-key branch.
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

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = (table: string) => {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b,
      upsert: () => b, delete: () => b,
      single: async () => state.single,
      then: (resolve: any) => resolve(state.tables[table] ?? { data: [], error: null }),
    }
    return b
  }
  return { createClient: () => ({ from: (t: string) => makeBuilder(t) }) }
})
// The guard's profile_bio lookups go through the shared admin client.
vi.mock("@/lib/supabase", () => {
  const client: any = { from: (_t: string) => profileBioBuilder(), rpc: async () => ({ data: null, error: null }) }
  return { supabase: client, supabaseAdmin: client }
})
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))

const awardCalls: string[] = []
vi.mock("@/lib/rewards", () => ({
  awardPoints: async (userId: string, action: string) => {
    awardCalls.push(`${userId}:${action}`)
  },
}))

import { GET, POST, DELETE } from "@/app/api/watchlist/route"

const get = (qs: string) => GET({ nextUrl: new URL(`https://t/api/watchlist?${qs}`) } as any)
const post = (body: any) => POST(new Request("https://t/api/watchlist", { method: "POST", body: JSON.stringify(body) }) as any)
const del = (body: any) => DELETE(new Request("https://t/api/watchlist", { method: "DELETE", body: JSON.stringify(body) }) as any)

beforeEach(() => {
  state.user = { id: "u1" }
  state.tables = {}
  state.single = { data: null, error: null }
  ownership.claimantId = "u1"
  ownership.claimantErr = null
  ownership.selfUsername = null
  ownership.selfErr = null
  awardCalls.length = 0
})

describe("/api/watchlist guards", () => {
  it("GET 400s without owner_key", async () => {
    expect((await get("")).status).toBe(400)
  })
  it("POST 400s without owner_key", async () => {
    expect((await post({ edition_key: "73:2785" })).status).toBe(400)
  })
  it("POST 400s without edition_key", async () => {
    expect((await post({ owner_key: "trevor" })).status).toBe(400)
  })
})

describe("/api/watchlist success paths", () => {
  it("GET 200s with [] when the owner has no watchlist rows", async () => {
    state.tables.watchlist = { data: [], error: null }
    const res = await get("owner_key=nobody")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("GET 200s and enriches a watchlist row with fmv + discount", async () => {
    state.tables.watchlist = { data: [{ edition_key: "73:2785", owner_key: "trevor" }], error: null }
    state.tables.editions = { data: [{ id: "ed-uuid", external_id: "73:2785" }], error: null }
    state.tables.fmv_current = { data: [{ edition_id: "ed-uuid", fmv_usd: 100, computed_at: "2026-07-01" }], error: null }
    state.tables.badge_editions = { data: [{ edition_key: "73:2785", low_ask: 80 }], error: null }
    state.tables.fmv_alerts = { data: [{ edition_key: "73:2785" }], error: null }
    const res = await get("owner_key=trevor")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].fmv).toBe(100)
    expect(body[0].low_ask).toBe(80)
    expect(body[0].discount_pct).toBe(20) // (100-80)/100
    expect(body[0].has_alert).toBe(true)
  })

  it("POST 201s, echoes the upserted row, and awards the GUARDED session user", async () => {
    state.single = { data: { id: "wl1", owner_key: "trevor", edition_key: "73:2785" }, error: null }
    const res = await post({ owner_key: "trevor", edition_key: "73:2785" })
    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe("wl1")
    expect(awardCalls).toContain("u1:add_watchlist_item")
  })

  it("DELETE 200s on a scoped removal", async () => {
    state.tables.watchlist = { data: null, error: null }
    const res = await del({ owner_key: "trevor", edition_key: "73:2785" })
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
  })
})

// ── the ownership contract (the IDOR that was closed) ───────────────────────
// Before the guard, `?owner_key=<their public username>` returned another
// user's private watchlist AND which editions they hold price alerts on, and
// the write verbs let anyone edit that list.
describe("/api/watchlist — ownership guard", () => {
  it("GET 401s when unauthenticated, without leaking rows", async () => {
    state.user = null
    state.tables.watchlist = { data: [{ edition_key: "secret-edition", owner_key: "victim" }], error: null }
    const res = await get("owner_key=victim")
    expect(res.status).toBe(401)
    expect(JSON.stringify(await res.json())).not.toContain("secret-edition")
  })

  it("GET 403s when owner_key is claimed by a DIFFERENT user", async () => {
    state.user = { id: "attacker" }
    ownership.claimantId = "victim"
    state.tables.watchlist = { data: [{ edition_key: "secret-edition", owner_key: "victim" }], error: null }
    const res = await get("owner_key=victim")
    expect(res.status).toBe(403)
    expect(JSON.stringify(await res.json())).not.toContain("secret-edition")
  })

  it("POST 401s when unauthenticated and awards nothing", async () => {
    state.user = null
    state.single = { data: { id: "wl1" }, error: null }
    const res = await post({ owner_key: "victim", edition_key: "73:2785" })
    expect(res.status).toBe(401)
    expect(awardCalls).toEqual([])
  })

  it("POST 403s when owner_key is claimed by a DIFFERENT user", async () => {
    state.user = { id: "attacker" }
    ownership.claimantId = "victim"
    state.single = { data: { id: "wl1" }, error: null }
    const res = await post({ owner_key: "victim", edition_key: "73:2785" })
    expect(res.status).toBe(403)
    expect(awardCalls).toEqual([])
  })

  it("DELETE 401s when unauthenticated", async () => {
    state.user = null
    const res = await del({ owner_key: "victim", edition_key: "73:2785" })
    expect(res.status).toBe(401)
  })

  it("DELETE 403s when owner_key is claimed by a DIFFERENT user", async () => {
    state.user = { id: "attacker" }
    ownership.claimantId = "victim"
    const res = await del({ owner_key: "victim", edition_key: "73:2785" })
    expect(res.status).toBe(403)
  })

  it("fails CLOSED with 403 when the ownership lookup itself errors", async () => {
    ownership.claimantErr = { message: "profile_bio unavailable" }
    state.tables.watchlist = { data: [{ edition_key: "secret-edition" }], error: null }
    const res = await get("owner_key=trevor")
    expect(res.status).toBe(403)
  })
})
