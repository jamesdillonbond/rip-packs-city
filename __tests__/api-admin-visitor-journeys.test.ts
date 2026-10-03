import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/admin/visitor-journeys — operator-token-gated visit timelines.
// Pins: 401 without the token; the hours window is clamped (never a 0-hour or
// unbounded read); and a failed RPC is a 500, never an empty board — "0
// sessions" is a claim that nobody visited.

const state: any = {}
vi.mock("@/lib/supabase", () => {
  const client: any = { rpc: async (fn: string, args: any) => state.rpc(fn, args) }
  return { supabaseAdmin: client, supabase: client }
})

import { GET, parseHours } from "@/app/api/admin/visitor-journeys/route"

const reqWith = (auth: string | null, qs = "") =>
  ({
    headers: new Headers(auth ? { authorization: auth } : {}),
    nextUrl: new URL(`https://x.test/api/admin/visitor-journeys${qs}`),
  }) as any

beforeEach(() => {
  process.env.RPC_ADMIN_TOKEN = "tok"
  state.calls = []
  state.rpc = async (fn: string, args: any) => {
    state.calls.push({ fn, args })
    return { data: { generated_at: "x", window_hours: args.p_hours, totals: {}, sessions: [] }, error: null }
  }
})

describe("GET /api/admin/visitor-journeys", () => {
  it("401s without the operator token and never calls the RPC", async () => {
    const res = await GET(reqWith(null))
    expect(res.status).toBe(401)
    expect(state.calls).toHaveLength(0)
  })

  it("passes a clamped window to admin_visitor_journeys", async () => {
    const res = await GET(reqWith("Bearer tok", "?hours=72"))
    expect(res.status).toBe(200)
    expect(state.calls[0]).toEqual({ fn: "admin_visitor_journeys", args: { p_hours: 72, p_max_sessions: 150 } })
  })

  it("parseHours: default 24, clamped to 1..168", () => {
    expect(parseHours(null)).toBe(24)
    expect(parseHours("abc")).toBe(24)
    expect(parseHours("0")).toBe(1)
    expect(parseHours("9999")).toBe(168)
    expect(parseHours("6")).toBe(6)
  })

  it("a failed RPC is a 500 with the error, not an empty board", async () => {
    state.rpc = async () => ({ data: null, error: { message: "statement timeout" } })
    const res = await GET(reqWith("Bearer tok"))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.sessions).toBeUndefined()
    expect(body.error).toMatch(/statement timeout/)
  })

  it("a payload without a sessions array is refused, not rendered as zero", async () => {
    state.rpc = async () => ({ data: null, error: null })
    expect((await GET(reqWith("Bearer tok"))).status).toBe(500)
  })
})
