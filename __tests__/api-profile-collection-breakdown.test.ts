import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/collection-breakdown.
// The public ?ownerKey path resolves username → user_id via profile_bio; the
// no-ownerKey path falls back to getCurrentUser(). Both failure modes return
// 200 with { collections: [] } + a meta hint (fail-soft, not 401). Pin: the
// unauthenticated no-ownerKey path, the owner-not-found path, and an authed
// happy path where get_user_saved_wallets returns [] → meta.no_wallets.

const state: { user: any; bio: { data: any; error: any }; savedWallets: { data: any; error: any } } = {
  user: null,
  bio: { data: null, error: null },
  savedWallets: { data: [], error: null },
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
  supabaseAdmin: {
    from: () => chain(() => state.bio),
    rpc: async (name: string) => (name === "get_user_saved_wallets" ? state.savedWallets : { data: [], error: null }),
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/collection-breakdown/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.bio = { data: null, error: null }
  state.savedWallets = { data: [], error: null }
})

describe("GET /api/profile/collection-breakdown", () => {
  it("returns { collections: [], meta.unauthenticated } with no ownerKey and no session", async () => {
    state.user = null
    const res = await GET(req("https://t/api/profile/collection-breakdown"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collections).toEqual([])
    expect(body.meta.unauthenticated).toBe(true)
  })

  it("returns meta.owner_not_found for an unresolvable ownerKey", async () => {
    state.bio = { data: null, error: null }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=ghost"))
    expect(res.status).toBe(200)
    expect((await res.json()).meta.owner_not_found).toBe(true)
  })

  it("returns meta.no_wallets when the resolved user has no saved wallets", async () => {
    state.bio = { data: { user_id: "u1" }, error: null }
    state.savedWallets = { data: [], error: null }
    const res = await GET(req("https://t/api/profile/collection-breakdown?ownerKey=trevor"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collections).toEqual([])
    expect(body.meta.no_wallets).toBe(true)
  })
})
