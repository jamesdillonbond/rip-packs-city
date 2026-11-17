import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/rewards/track.
// Cookie-session auth via requireUser (401 Response when unauthed). The body
// carries only a fixed `event` string, mapped server-side to a capped earn rule
// via a hardcoded allowlist. Pins: unauth → 401, invalid JSON → 400, an event
// not on the allowlist → 400, and a mocked allowed-event happy path (→ 200).

const state: { user: any; award: any } = { user: { id: "u1" }, award: { awarded: true } }

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!state.user)
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    return state.user
  },
}))
vi.mock("@/lib/rewards", () => ({
  awardPoints: async () => state.award,
}))

import { POST } from "@/app/api/rewards/track/route"

function req(opts: { body?: any; badJson?: boolean }) {
  return { json: async () => { if (opts.badJson) throw new Error("x"); return opts.body ?? {} } } as any
}

beforeEach(() => {
  state.user = { id: "u1" }
  state.award = { awarded: true }
})

describe("POST /api/rewards/track", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await POST(req({ body: { event: "view_squeeze" } }))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("400s on an invalid JSON body", async () => {
    expect((await POST(req({ badJson: true }))).status).toBe(400)
  })

  it("400s on an event not in the allowlist", async () => {
    const res = await POST(req({ body: { event: "arbitrary_action_key" } }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unknown_event")
  })

  it("200s for an allowlisted event", async () => {
    state.award = { awarded: true }
    const res = await POST(req({ body: { event: "view_squeeze" } }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.awarded).toBe(true)
  })
})
