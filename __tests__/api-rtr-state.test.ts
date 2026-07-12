import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/rtr/state (GET + POST). Both verbs are
// requireUser-gated (fail-closed 401). GET happy path: no row → the default
// Prospect payload (maybeSingle → {data:null}). POST guards: malformed_json
// 400, invalid_body 400 (zod coerces int 0..10_000_000), then a mocked upsert
// happy path with the tier derived from reportedTotalPoints.

const state: { user: any; result: any } = { user: null, result: { data: null, error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    upsert: () => b,
    maybeSingle: async () => state.result,
    single: async () => state.result,
  }
  const admin: any = { from: () => b }
  return { supabaseAdmin: admin, supabase: admin }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
  getCurrentUser: async () => state.user,
}))

import { GET, POST } from "@/app/api/rtr/state/route"

function post(body: string): NextRequest {
  return new NextRequest("https://t/api/rtr/state", {
    method: "POST",
    headers: new Headers({ "content-type": "application/json" }),
    body,
  })
}

beforeEach(() => {
  state.user = null
  state.result = { data: null, error: null }
})

describe("GET /api/rtr/state", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    expect((await GET()).status).toBe(401)
  })

  it("returns the default Prospect state when the user has no row", async () => {
    state.user = { id: "u1" }
    state.result = { data: null, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reportedTotalPoints).toBe(0)
    expect(body.currentTier).toBe("Prospect")
  })
})

describe("POST /api/rtr/state", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    expect((await POST(post(JSON.stringify({ reportedTotalPoints: 0, reportedSpendableBalance: 0 })))).status).toBe(401)
  })

  it("400s on malformed JSON", async () => {
    state.user = { id: "u1" }
    const res = await POST(post("{bad"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("malformed_json")
  })

  it("400s invalid_body when required fields are missing", async () => {
    state.user = { id: "u1" }
    const res = await POST(post(JSON.stringify({ reportedTotalPoints: -5 })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("invalid_body")
  })

  it("upserts and derives the tier for an authed user", async () => {
    state.user = { id: "u1" }
    state.result = {
      data: {
        reported_total_points: 15000,
        reported_spendable_balance: 500,
        current_tier: "All-Star",
        reported_at: "2026-07-12T00:00:00Z",
        updated_at: "2026-07-12T00:00:00Z",
      },
      error: null,
    }
    const res = await POST(post(JSON.stringify({ reportedTotalPoints: 15000, reportedSpendableBalance: 500 })))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.currentTier).toBe("All-Star")
    expect(body.reportedTotalPoints).toBe(15000)
  })
})
