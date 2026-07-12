import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for /api/alerts/subscriptions (deal-feed subs CRUD).
// requireUser() throws a 401 Response when unauthenticated. We pin the auth
// guard (GET/POST) and the authed POST validation guards (invalid JSON -> 400;
// an explicit empty channels[] -> 400), PLUS the 2xx success paths: GET lists the
// user's subs each with a preview_count, and POST (no id) creates a sub -> 201.
// The chainable Supabase stub lives in vi.hoisted (see channels test for why).

const h = vi.hoisted(() => {
  const state: { listResult: any; singleResult: any } = {
    listResult: { data: [], error: null },
    singleResult: { data: null, error: null },
  }
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    order: () => sb,
    insert: () => sb,
    update: () => sb,
    delete: () => sb,
    single: async () => state.singleResult,
    maybeSingle: async () => state.singleResult,
    then: (resolve: any) => resolve(state.listResult),
  }
  return { sb, state }
})

const auth: { user: any } = { user: null }

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))
vi.mock("@/lib/alerts", () => ({
  CHANNELS: ["email", "telegram", "discord"],
  buildDealAlertsForSubscription: async () => ({ deals_count: 3, deals: [{ id: "d1" }] }),
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
  h.state.listResult = { data: [], error: null }
  h.state.singleResult = { data: null, error: null }
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

  it("GET 200s (authed) listing subs enriched with a preview_count", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.listResult = { data: [{ id: "sub1", label: "My deal alert", channels: ["email"] }], error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.subscriptions).toHaveLength(1)
    expect(body.subscriptions[0].id).toBe("sub1")
    expect(body.subscriptions[0].preview_count).toBe(3)
    expect(body.subscriptions[0].preview_deals).toHaveLength(1)
  })

  it("POST 201s (authed) creating a new subscription", async () => {
    auth.user = { id: "u1", email: "a@b.co" }
    h.state.singleResult = { data: { id: "sub1", label: "My deal alert", channels: ["email"] }, error: null }
    const res = await POST(post(JSON.stringify({ label: "My deal alert", channels: ["email"] })))
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.subscription.id).toBe("sub1")
    expect(body.subscription.preview_count).toBe(3)
  })
})
