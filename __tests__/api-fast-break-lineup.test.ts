import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/fast-break/lineup.
// Auth is cookie-based via requireUser() (throws a 401 Response). We pin the
// pre-DB guards: 401 unauthenticated, 400 malformed JSON, 400 invalid body,
// 400 duplicate players in the body, and one light mocked seam (404 when the
// run row is missing). The heavy save_fast_break_lineup RPC path is not
// exercised — the guards above all return before it.

const authState: { user: any } = { user: null }
const state: { tables: Record<string, any>; rpc: Record<string, any> } = { tables: {}, rpc: {} }

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (authState.user) return authState.user
    throw new Response(JSON.stringify({ error: "Authentication required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    })
  },
}))

vi.mock("@/lib/supabase", () => {
  const makeBuilder = (table: string) => {
    const b: any = {}
    for (const m of ["select", "eq", "in", "order", "gt", "gte", "lt"]) b[m] = () => b
    b.single = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.maybeSingle = async () => state.tables[table]?.single ?? { data: null, error: null }
    b.then = (resolve: any) => resolve(state.tables[table]?.list ?? { data: [], error: null })
    return b
  }
  const admin: any = {
    from: (t: string) => makeBuilder(t),
    rpc: async (name: string) => state.rpc[name] ?? { data: null, error: null },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { POST } from "@/app/api/fast-break/lineup/route"

const UUID_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const UUID_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const RUN_ID = "11111111-1111-4111-8111-111111111111"

const req = (body: any, opts: { bad?: boolean } = {}) =>
  ({
    headers: new Headers(),
    nextUrl: new URL("https://t/api/fast-break/lineup"),
    json: async () => {
      if (opts.bad) throw new Error("bad json")
      return body
    },
  }) as any

const validBody = (players: any[]) => ({
  walletAddr: "0xabcdef0123456789",
  runId: RUN_ID,
  gameDate: "2026-07-12",
  players,
})

beforeEach(() => {
  authState.user = { id: "user-1" }
  state.tables = {}
  state.rpc = {}
})

describe("POST /api/fast-break/lineup", () => {
  it("401s when unauthenticated (requireUser throws)", async () => {
    authState.user = null
    const res = await POST(req(validBody([{ nbaPlayerId: UUID_A, momentId: "m1", serial: 1 }])))
    expect(res.status).toBe(401)
  })

  it("400s on malformed JSON", async () => {
    const res = await POST(req(null, { bad: true }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("malformed_json")
  })

  it("400s on an invalid body", async () => {
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("400s on duplicate nbaPlayerIds in the body", async () => {
    const res = await POST(
      req(
        validBody([
          { nbaPlayerId: UUID_A, momentId: "m1", serial: 1 },
          { nbaPlayerId: UUID_A, momentId: "m2", serial: 2 },
        ]),
      ),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("duplicate_players_in_body")
  })

  it("404s when the run is not found", async () => {
    state.tables.fast_break_runs = { single: { data: null, error: null } }
    const res = await POST(
      req(
        validBody([
          { nbaPlayerId: UUID_A, momentId: "m1", serial: 1 },
          { nbaPlayerId: UUID_B, momentId: "m2", serial: 2 },
        ]),
      ),
    )
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("run_not_found")
  })
})
