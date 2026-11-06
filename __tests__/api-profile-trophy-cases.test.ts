import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/profile/trophy-cases (2026-11-06) + the challenge leg of
// POST /api/profile/trophy. Pins: a failed cases read is a 503 and never an
// empty list; the 10-case cap; one entry per challenge (23505 → 409); a pin into
// a challenge case that fails the rules is refused BEFORE any write; a failed
// rule check is a 503, never "not eligible".

type R = { data: any; error: any; count?: number | null }
const state: {
  user: any
  tables: Record<string, R>
  rpc: R
  inserts: any[]
  upserts: any[]
  insertResult: R
} = { user: null, tables: {}, rpc: { data: [], error: null }, inserts: [], upserts: [], insertResult: { data: null, error: null } }

vi.mock("@/lib/supabase", () => {
  const build = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "not", "limit", "is", "order", "update", "delete"]) b[m] = () => b
    b.insert = (row: any) => {
      state.inserts.push({ table, row })
      const r: any = { select: () => r, single: async () => state.insertResult, then: (res: any) => res(state.insertResult) }
      return r
    }
    b.upsert = (row: any) => {
      state.upserts.push({ table, row })
      return b
    }
    b.single = async () => state.tables[table] ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table] ?? { data: null, error: null }
    b.then = (res: any) => res(state.tables[table] ?? { data: [], error: null })
    return b
  }
  const client: any = { from: (t: string) => build(t), rpc: async () => state.rpc }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user) throw new Response(JSON.stringify({ error: "Authentication required" }), { status: 401 })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { GET, POST, DELETE } from "@/app/api/profile/trophy-cases/route"
import { POST as PIN } from "@/app/api/profile/trophy/route"

const req = (body?: any) => ({ json: async () => body, headers: { get: () => null } }) as any
const CASE = "11111111-1111-4111-8111-111111111111"
const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

beforeEach(() => {
  state.user = { id: "u1" }
  state.tables = {}
  state.rpc = { data: [], error: null }
  state.inserts = []
  state.upserts = []
  state.insertResult = { data: { id: CASE }, error: null }
})

describe("GET /api/profile/trophy-cases", () => {
  it("401s signed out", async () => {
    state.user = null
    expect((await GET()).status).toBe(401)
  })

  it("⚠ a failed cases read is a 503, NEVER { cases: [] }", async () => {
    state.rpc = { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
    const res = await GET()
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.cases).toBeUndefined()
  })

  it("a failed challenge-list read leaves the cases and reports challenges as unknown (null)", async () => {
    state.rpc = { data: [{ id: CASE, name: "x", slabs: [] }], error: null }
    state.tables.trophy_challenges = { data: null, error: { message: "boom" } }
    const body = await (await GET()).json()
    expect(body.cases).toHaveLength(1)
    expect(body.challenges).toBeNull()
  })
})

describe("POST /api/profile/trophy-cases", () => {
  it("refuses at the 10-case cap", async () => {
    state.tables.trophy_cases = { data: null, error: null, count: 10 }
    const res = await POST(req({ name: "Rookies" }))
    expect(res.status).toBe(409)
    expect(state.inserts).toHaveLength(0)
  })

  it("a failed count is not read as zero", async () => {
    state.tables.trophy_cases = { data: null, error: null, count: null }
    const res = await POST(req({ name: "Rookies" }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(state.inserts).toHaveLength(0)
  })

  it("creates a named case", async () => {
    state.tables.trophy_cases = { data: null, error: null, count: 0 }
    const res = await POST(req({ name: "  Rookie   Class " }))
    expect(res.status).toBe(201)
    expect(state.inserts[0].row).toMatchObject({ user_id: "u1", name: "Rookie Class", challenge_id: null })
  })

  it("rejects an empty name", async () => {
    state.tables.trophy_cases = { data: null, error: null, count: 0 }
    expect((await POST(req({ name: "   " }))).status).toBe(400)
  })

  it("enters a challenge once; a second entry is a 409, not a 500", async () => {
    state.tables.trophy_cases = { data: null, error: null, count: 1 }
    state.tables.trophy_challenges = { data: [{ id: "ch1", title: "Dame Time", is_active: true, ends_at: null }], error: null }
    const ok = await POST(req({ challengeSlug: "dame-time" }))
    expect(ok.status).toBe(201)
    expect(state.inserts[0].row).toMatchObject({ challenge_id: "ch1", name: "Dame Time" })

    state.insertResult = { data: null, error: { code: "23505", message: "duplicate key" } }
    const dup = await POST(req({ challengeSlug: "dame-time" }))
    expect(dup.status).toBe(409)
    expect((await dup.json()).code).toBe("already_entered")
  })

  it("a closed challenge takes no entries", async () => {
    state.tables.trophy_cases = { data: null, error: null, count: 0 }
    state.tables.trophy_challenges = { data: [{ id: "ch1", title: "Dame Time", is_active: false, ends_at: null }], error: null }
    expect((await POST(req({ challengeSlug: "dame-time" }))).status).toBe(409)
    expect(state.inserts).toHaveLength(0)
  })
})

describe("DELETE /api/profile/trophy-cases", () => {
  it("404s when nothing was deleted (ok is derived, never hardcoded)", async () => {
    state.tables.trophy_cases = { data: [], error: null }
    expect((await DELETE(req({ caseId: CASE }))).status).toBe(404)
  })
  it("requires a caseId", async () => {
    expect((await DELETE(req({}))).status).toBe(400)
  })
})

describe("POST /api/profile/trophy into a CHALLENGE case", () => {
  const dameCase = {
    data: [
      {
        id: CASE,
        name: "Dame Time",
        challenge_id: "ch1",
        trophy_challenges: {
          id: "ch1",
          slug: "dame-time",
          title: "Dame Time",
          is_active: true,
          ends_at: null,
          rules: { player_names: ["Damian Lillard"], collection_slugs: ["nba_top_shot"], require_owned: true },
        },
      },
    ],
    error: null,
  }

  it("refuses a non-Dame Moment BEFORE writing anything", async () => {
    state.tables.trophy_cases = dameCase
    state.tables.collections = { data: [{ slug: "nba_top_shot" }], error: null }
    state.tables.saved_wallets = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.tables.wallet_moments_cache = { data: [{ edition_key: "1:2" }], error: null }
    state.tables.editions = { data: [{ player_name: "Jusuf Nurkic" }], error: null }
    // The body CLAIMS Dame; the server must not believe it.
    const res = await PIN(req({ slot: 1, momentId: "m1", collectionId: TS, caseId: CASE, playerName: "Damian Lillard" }))
    expect(res.status).toBe(422)
    expect(state.upserts).toHaveLength(0)
  })

  it("⚠ a failed rule check is a 503 and writes nothing", async () => {
    state.tables.trophy_cases = dameCase
    state.tables.collections = { data: null, error: { message: "boom" } }
    const res = await PIN(req({ slot: 1, momentId: "m1", collectionId: TS, caseId: CASE }))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect(state.upserts).toHaveLength(0)
  })

  it("pins a held Dame Moment into the case", async () => {
    state.tables.trophy_cases = dameCase
    state.tables.collections = { data: [{ slug: "nba_top_shot" }], error: null }
    state.tables.saved_wallets = { data: [{ wallet_addr: "0xabc" }], error: null }
    state.tables.wallet_moments_cache = { data: [{ edition_key: "1:2" }], error: null }
    state.tables.editions = { data: [{ player_name: "Damian Lillard" }], error: null }
    state.tables.trophy_moments = { data: { id: 9, slot: 1 }, error: null }
    const res = await PIN(req({ slot: 1, momentId: "m1", collectionId: TS, caseId: CASE }))
    expect(res.status).toBe(200)
    expect(state.upserts[0].row).toMatchObject({ case_id: CASE, user_id: "u1", slot: 1 })
  })

  it("a case the user doesn't own is a 404", async () => {
    state.tables.trophy_cases = { data: [], error: null }
    const res = await PIN(req({ slot: 1, momentId: "m1", collectionId: TS, caseId: CASE }))
    expect(res.status).toBe(404)
    expect(state.upserts).toHaveLength(0)
  })
})
