import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/touch (POST only). Resolves the user
// from the cookie session first, then a Bearer access-token fallback; 401 when
// neither yields an id. Pins the fail-closed 401 and a mocked cookie-session
// happy path (user_profiles upsert → {ok:true}).

const state: { user: any; upsertError: any } = { user: null, upsertError: null }

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      upsert: () => b,
      then: (resolve: any) => resolve({ error: state.upsertError }),
    }
    return b
  }
  const client: any = {
    from: () => build(),
    auth: { getUser: async () => ({ data: { user: null }, error: null }) },
  }
  return { supabase: client, supabaseAdmin: client }
})

const welcome = vi.hoisted(() => ({ calls: [] as Array<{ userId: unknown; email: unknown }> }))
vi.mock("@/lib/welcome/send-account-welcome", () => ({
  sendAccountWelcomeOnce: async (input: { userId: unknown; email: unknown }) => {
    welcome.calls.push(input)
    return { status: "sent" }
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { POST } from "@/app/api/profile/touch/route"

const req = (auth?: string) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
  }) as any

beforeEach(() => {
  state.user = null
  state.upsertError = null
  welcome.calls = []
})

describe("POST /api/profile/touch", () => {
  it("401s with no cookie session and no Bearer header (fail-closed)", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("upserts and returns ok for a cookie-session user", async () => {
    state.user = { id: "u1" }
    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(typeof body.last_active_at).toBe("string")
  })

  it("500s when the upsert errors", async () => {
    state.user = { id: "u1" }
    state.upsertError = { message: "db down" }
    expect((await POST(req())).status).toBe(500)
  })
})

describe("POST /api/profile/touch — the one-time welcome (review M2)", () => {
  it("schedules the welcome after a successful touch, with the session user's id and email", async () => {
    state.user = { id: "u1", email: "u1@example.com" }
    await POST(req())
    expect(welcome.calls).toEqual([{ userId: "u1", email: "u1@example.com" }])
  })
  it("does not schedule it on a 401 or a failed upsert", async () => {
    await POST(req())
    state.user = { id: "u1", email: "u1@example.com" }
    state.upsertError = { message: "db down" }
    await POST(req())
    expect(welcome.calls).toEqual([])
  })
})
