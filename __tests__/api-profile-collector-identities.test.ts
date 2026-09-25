import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/profile/collector-identities — linking a Panini USERNAME to a profile
// (2026-09-25). Pins the three states (read failed ≠ username not seen ≠ seen),
// the 5-per-user cap shared with saved wallets, and the lowercased stored form.

const PANINI_UUID = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

const state: {
  user: any
  tables: Record<string, any>
  rpc: any
  inserts: any[]
  planLimit: number | null
} = { user: null, tables: {}, rpc: null, inserts: [], planLimit: 5 }

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    const b: any = {
      select: () => b, update: () => b, upsert: () => b,
      delete: () => b, eq: () => b, order: () => b, limit: () => b,
      insert: (row: any) => {
        state.inserts.push({ table, row })
        return { then: (resolve: any) => resolve({ error: null }) }
      },
      single: async () => state.tables[table] ?? { data: null, error: null },
      maybeSingle: async () => state.tables[table + ":single"] ?? { data: null, error: null },
      then: (resolve: any) => resolve(state.tables[table] ?? { data: [], error: null, count: 0 }),
    }
    return b
  }
  const client: any = { from: (t: string) => build(t), rpc: async () => state.rpc }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return state.user
  },
}))

vi.mock("@/lib/pro-tier", () => ({
  checkFeatureQuota: async () => ({ daily_limit: state.planLimit, plan: "free" }),
}))

import { GET, POST } from "@/app/api/profile/collector-identities/route"

const req = (body: any) => ({ json: async () => body }) as any

const seen = (n: number) => ({
  data: { username: "moesidani", cards_seen: n, listed_now: n, special_serials: 0, editions: n, last_seen_at: null },
  error: null,
})

beforeEach(() => {
  state.user = { id: "u1" }
  state.tables = {
    saved_wallets: { data: [{ wallet_addr: "0xbd94cade097e50ac" }], error: null },
    saved_collector_identities: { data: [], error: null, count: 0 },
  }
  state.rpc = seen(7731)
  state.inserts = []
  state.planLimit = 5
})

describe("POST /api/profile/collector-identities", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    expect((await POST(req({ username: "MoeSidani" }))).status).toBe(401)
  })

  it("400s on a string that is not a Panini username", async () => {
    const res = await POST(req({ username: "not a username!" }))
    expect(res.status).toBe(400)
    expect(state.inserts).toHaveLength(0)
  })

  it("stores the username LOWERCASED under the Panini collection", async () => {
    const res = await POST(req({ username: "MoeSidani" }))
    expect(res.status).toBe(200)
    expect(state.inserts).toEqual([
      {
        table: "saved_collector_identities",
        row: { user_id: "u1", collection_id: PANINI_UUID, identity_kind: "username", identity_value: "moesidani" },
      },
    ])
  })

  it("refuses a username RPC has never seen (404) and stores nothing", async () => {
    state.rpc = seen(0)
    const res = await POST(req({ username: "ghost_user" }))
    expect(res.status).toBe(404)
    expect(state.inserts).toHaveLength(0)
  })

  it("a FAILED summary read is an error, never 'username not seen'", async () => {
    state.rpc = { data: null, error: { message: "boom", code: "57014" } }
    const res = await POST(req({ username: "MoeSidani" }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).error).not.toBe("username_not_seen")
    expect(state.inserts).toHaveLength(0)
  })

  it("4 wallets + 1 linked username fills the free cap of 5 (402, nothing stored)", async () => {
    state.tables.saved_wallets = {
      data: ["0xa", "0xb", "0xc", "0xd"].map((wallet_addr) => ({ wallet_addr })),
      error: null,
    }
    state.tables.saved_collector_identities = { data: [], error: null, count: 1 }
    const res = await POST(req({ username: "MoeSidani" }))
    expect(res.status).toBe(402)
    expect(state.inserts).toHaveLength(0)
  })

  it("fails CLOSED when the linked-identity count cannot be read", async () => {
    state.tables.saved_collector_identities = { data: null, error: { message: "down" }, count: null }
    const res = await POST(req({ username: "MoeSidani" }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(state.inserts).toHaveLength(0)
  })

  it("a re-link of an already linked username skips the cap", async () => {
    state.planLimit = 0
    state.tables["saved_collector_identities:single"] = { data: { id: 1 }, error: null }
    const res = await POST(req({ username: "MoeSidani" }))
    expect(res.status).toBe(200)
    expect((await res.json()).created).toBe(false)
    expect(state.inserts).toHaveLength(0)
  })
})

describe("GET /api/profile/collector-identities", () => {
  it("a failed per-username summary is flagged, never rendered as 0 cards", async () => {
    state.tables.saved_collector_identities = {
      data: [{ collection_id: PANINI_UUID, identity_kind: "username", identity_value: "moesidani", created_at: "x" }],
      error: null,
    }
    state.rpc = { data: null, error: { message: "boom" } }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.identities[0].summary).toBeNull()
    expect(body.identities[0].summary_failed).toBe(true)
  })

  it("a failed list read is an error, not an empty list", async () => {
    state.tables.saved_collector_identities = { data: null, error: { message: "down" } }
    const res = await GET()
    expect(res.status).toBeGreaterThanOrEqual(500)
  })
})
