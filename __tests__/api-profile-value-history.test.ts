import { describe, it, expect, beforeEach, vi } from "vitest"

// /api/profile/value-history — the member's nightly snapshots (moments + sealed packs) for
// the dashboard Value / 30D card (2026-11-22). Pins: auth required; oldest-first; a NULL
// pack value stays null (not measured), never 0.

const state: { authed: boolean; rows: { data: any; error: any }; eqs: Array<[string, unknown]> } = {
  authed: true, rows: { data: [], error: null }, eqs: [],
}

function chain(): any {
  const b: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "then") return (res: any, rej: any) => Promise.resolve(state.rows).then(res, rej)
      if (prop === "eq") return (k: string, v: unknown) => { state.eqs.push([k, v]); return b }
      return () => b
    },
  })
  return b
}

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: () => chain() } }))
vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.authed) throw new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 })
    return { id: "user-1" }
  },
}))

import { GET } from "@/app/api/profile/value-history/route"

beforeEach(() => { state.authed = true; state.rows = { data: [], error: null }; state.eqs = [] })

describe("GET /api/profile/value-history", () => {
  it("requires a signed-in user", async () => {
    state.authed = false
    expect((await GET()).status).toBe(401)
  })
  it("reads only the caller's snapshots, oldest first, a missing pack value stays null", async () => {
    state.rows = { data: [
      { snapshot_date: "2026-11-22", total_fmv: "40547.10", moment_count: 3263, pack_low_ask_usd: "25533.70", pack_held_count: 327 },
      { snapshot_date: "2026-11-21", total_fmv: 40100, moment_count: 3260, pack_low_ask_usd: null, pack_held_count: null },
    ], error: null }
    const body = await (await GET()).json()
    expect(state.eqs).toEqual([["owner_key", "user-1"]])
    expect(body.history).toEqual([
      { date: "2026-11-21", moments_usd: 40100, packs_usd: null, packs_held: null },
      { date: "2026-11-22", moments_usd: 40547.1, packs_usd: 25533.7, packs_held: 327 },
    ])
  })
  it("a failed read is an error, never an empty history", async () => {
    state.rows = { data: null, error: { message: "boom", code: "57014" } }
    expect((await GET()).status).toBeGreaterThanOrEqual(500)
  })
})
