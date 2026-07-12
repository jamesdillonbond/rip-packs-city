import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts (session-authed per-edition FMV alerts).
// requireUser() throws a 401 Response when unauthenticated; the handlers catch
// it and return it. owner_key is always the session id. We pin the auth guard
// (GET/POST) and the authed POST validation guards (edition_key + alert_type).

const auth: { user: any } = { user: null }

vi.mock("@/lib/auth/supabase-server", () => ({
  requireUser: async () => {
    if (!auth.user) {
      throw new Response(JSON.stringify({ error: "Authentication required" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      })
    }
    return auth.user
  },
}))
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { GET, POST } from "@/app/api/alerts/route"

function req(body?: any): NextRequest {
  return new NextRequest("https://t/api/alerts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  auth.user = null
})

describe("/api/alerts", () => {
  it("GET 401s when unauthenticated", async () => {
    const res = await GET(new NextRequest("https://t/api/alerts"))
    expect(res.status).toBe(401)
  })

  it("POST 401s when unauthenticated", async () => {
    expect((await POST(req({ edition_key: "73:2785" }))).status).toBe(401)
  })

  it("POST 400s (authed) when edition_key is missing", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(req({ alert_type: "fmv_below", threshold: 5 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("edition_key is required")
  })

  it("POST 400s (authed) on an invalid alert_type", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(req({ edition_key: "73:2785", alert_type: "bogus", threshold: 5 }))
    expect(res.status).toBe(400)
  })
})
