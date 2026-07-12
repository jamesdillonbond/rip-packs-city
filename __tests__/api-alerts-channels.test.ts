import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts/channels (notification-channel links).
// requireUser() throws a 401 Response when unauthenticated. We pin the auth
// guard (GET/POST) and the authed POST validation guard (invalid channel → 400).
// isChannel is the real lib predicate.

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

import { GET, POST } from "@/app/api/alerts/channels/route"

function post(body?: any): NextRequest {
  return new NextRequest("https://t/api/alerts/channels", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

beforeEach(() => {
  auth.user = null
})

describe("/api/alerts/channels", () => {
  it("GET 401s when unauthenticated", async () => {
    expect((await GET()).status).toBe(401)
  })

  it("POST 401s when unauthenticated", async () => {
    expect((await POST(post({ channel: "email" }))).status).toBe(401)
  })

  it("POST 400s (authed) on an invalid channel", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(post({ channel: "carrier-pigeon" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("channel must be")
  })
})
