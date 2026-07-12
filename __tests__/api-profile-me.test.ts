import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/me.
// getCurrentUser()-gated but deliberately fail-SOFT: unauthenticated returns
// 200 { user: null } (never 401) so public pages can call it unconditionally.
// Pin the unauthenticated payload and an authed happy path enriched via
// allow_list + resolveDisplayName.

const state: { user: any; allow: { data: any; error: any } } = {
  user: null,
  allow: { data: null, error: null },
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { from: () => chain(() => state.allow) },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

vi.mock("@/lib/user/resolveDisplayName", () => ({
  resolveDisplayName: async () => ({ display_name: "Trevor", source: "profile_bio" }),
}))

import { GET } from "@/app/api/profile/me/route"

beforeEach(() => {
  state.user = null
  state.allow = { data: null, error: null }
})

describe("GET /api/profile/me", () => {
  it("returns { user: null } with no-store when unauthenticated (fail-soft, no 401)", async () => {
    state.user = null
    const res = await GET()
    expect(res.status).toBe(200)
    expect(res.headers.get("Cache-Control")).toBe("no-store")
    expect((await res.json()).user).toBeNull()
  })

  it("returns the enriched identity for an authed user", async () => {
    state.user = { id: "u1", email: "a@b.com", created_at: "2026-01-01" }
    state.allow = { data: { username: "trevor", wallet_addr: "0xabc" }, error: null }
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.user.id).toBe("u1")
    expect(body.user.username).toBe("trevor")
    expect(body.user.wallet_addr).toBe("0xabc")
    expect(body.user.display_name).toBe("Trevor")
    expect(body.user.display_name_source).toBe("profile_bio")
  })
})
