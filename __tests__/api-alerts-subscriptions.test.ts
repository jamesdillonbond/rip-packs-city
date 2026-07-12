import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts/subscriptions (deal-feed subs CRUD).
// requireUser() throws a 401 Response when unauthenticated. We pin the auth
// guard (GET/POST) and the authed POST validation guards (invalid JSON → 400;
// an explicit empty channels[] → 400). CHANNELS is the real lib constant.

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

import { GET, POST } from "@/app/api/alerts/subscriptions/route"

function post(raw?: string): NextRequest {
  return new NextRequest("https://t/api/alerts/subscriptions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  })
}

beforeEach(() => {
  auth.user = null
})

describe("/api/alerts/subscriptions", () => {
  it("GET 401s when unauthenticated", async () => {
    expect((await GET()).status).toBe(401)
  })

  it("POST 401s when unauthenticated", async () => {
    expect((await POST(post("{}"))).status).toBe(401)
  })

  it("POST 400s (authed) on invalid JSON", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(post("not-json"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Invalid JSON body")
  })

  it("POST 400s (authed) when channels[] is explicitly empty", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(post(JSON.stringify({ channels: [] })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("delivery channel")
  })
})
