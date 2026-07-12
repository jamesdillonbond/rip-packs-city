import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts/channels (notification-channel links).
// requireUser() throws a 401 Response when unauthenticated. We pin the auth
// guard (GET/POST) and the authed POST validation guard (invalid channel -> 400),
// PLUS the 2xx success paths: GET returns the masked channel list, and POST for a
// telegram link returns the code + bot deep links (createChannelLinkCode mocked).
// The chainable Supabase stub lives in vi.hoisted so it initialises before the
// hoisted vi.mock reads it (top-level route import triggers the factory early).

const h = vi.hoisted(() => {
  const state: { dbResult: { data: any; error: any } } = { dbResult: { data: [], error: null } }
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    delete: () => sb,
    then: (resolve: any) => resolve(state.dbResult),
  }
  return { sb, state }
})

const auth: { user: any } = { user: null }
const link = { current: { ok: true, code: "CODE123", expires_at: "2026-07-12T00:15:00Z" } as any }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))
vi.mock("@/lib/alerts", () => ({
  isChannel: (c: unknown) => c === "email" || c === "telegram" || c === "discord",
  createChannelLinkCode: async () => link.current,
}))
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
  h.state.dbResult = { data: [], error: null }
  link.current = { ok: true, code: "CODE123", expires_at: "2026-07-12T00:15:00Z" }
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

  it("GET 200s (authed) with the masked channel list", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.dbResult = {
      data: [
        {
          channel: "email",
          channel_user_id: "user@example.com",
          channel_username: null,
          verified: true,
          verified_at: "2026-07-01T00:00:00Z",
          last_used_at: null,
        },
      ],
      error: null,
    }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.channels).toHaveLength(1)
    expect(body.channels[0].channel).toBe("email")
    expect(body.channels[0].verified).toBe(true)
    expect(body.channels[0].target).toContain("@example.com")
  })

  it("POST 200s (authed) for a telegram link — returns code + deep link", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    const res = await POST(post({ channel: "telegram" }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.channel).toBe("telegram")
    expect(body.pending).toBe(true)
    expect(body.code).toBe("CODE123")
    expect(body).toHaveProperty("instruction")
  })
})
