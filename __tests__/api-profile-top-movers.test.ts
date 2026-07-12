import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/top-movers. Like tier-breakdown this
// is a public collector-showcase read: it never 401s, returning a 200 empty
// shape ({gainers:[],losers:[]}) with a meta reason. Pins the unauthenticated
// fallback, the owner_not_found branch, and the no_wallets branch.

const state: { user: any; single: any; rpc: any } = {
  user: null,
  single: { data: null, error: null },
  rpc: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, eq: () => b, ilike: () => b,
      maybeSingle: async () => state.single,
      then: (resolve: any) => resolve(state.single),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.rpc }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/top-movers/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.single = { data: null, error: null }
  state.rpc = { data: [], error: null }
})

describe("GET /api/profile/top-movers", () => {
  it("returns a 200 empty shape with meta.unauthenticated (no ownerKey, no session)", async () => {
    const res = await GET(req("https://t/api/profile/top-movers"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ gainers: [], losers: [] })
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns owner_not_found meta for an unknown ownerKey", async () => {
    const body = await (await GET(req("https://t/api/profile/top-movers?ownerKey=ghost"))).json()
    expect(body.meta.owner_not_found).toBe(true)
  })

  it("returns no_wallets meta when the resolved user has no saved wallets", async () => {
    state.single = { data: { user_id: "u1" }, error: null }
    state.rpc = { data: [], error: null }
    const body = await (await GET(req("https://t/api/profile/top-movers?ownerKey=trevor"))).json()
    expect(body.meta.no_wallets).toBe(true)
  })
})
