import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/hero-moment.
// Resolution order: ?ownerKey → getCurrentUser() → smoke-test header. When no
// user resolves and it is not a smoke request, the handler 401s with
// { hero: null, reason: "no_user" }. Pin that fail-closed 401, then an authed
// happy path (getCurrentUser resolves the user, get_user_hero_moment returns a
// priced row → 200 hero), and the no-FMV fall-through.

const state: { user: any; rpc: { data: any; error: any } } = {
  user: null,
  rpc: { data: null, error: null },
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
    from: () => chain(() => ({ data: null, error: null })),
    rpc: async () => state.rpc,
  },
}))

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/hero-moment/route"

const req = (url: string, headers: Record<string, string> = {}) =>
  ({
    nextUrl: new URL(url),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  }) as any

const TOPSHOT_UUID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

beforeEach(() => {
  state.user = null
  state.rpc = { data: null, error: null }
})

describe("GET /api/profile/hero-moment", () => {
  it("401s with reason no_user when no user resolves and it is not a smoke request", async () => {
    state.user = null
    const res = await GET(req("https://t/api/profile/hero-moment"))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.hero).toBeNull()
    expect(body.reason).toBe("no_user")
  })

  it("returns the hero for an authed user with a priced moment", async () => {
    state.user = { id: "u1" }
    state.rpc = {
      data: [
        {
          moment_id: "m1",
          player_name: "Dame",
          set_name: "Base",
          tier: "RARE",
          serial_number: 5,
          mint_count: 100,
          image_url: null,
          edition_key: "1:1",
          fmv_usd: 42,
          is_locked: false,
          is_manual_override: false,
          collection_id: TOPSHOT_UUID,
        },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/profile/hero-moment"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hero.momentId).toBe("m1")
    expect(body.hero.fmvUsd).toBe(42)
    expect(body.hero.collectionUuid).toBe(TOPSHOT_UUID)
  })

  it("returns hero:null reason no_fmv when the top moment has no positive FMV", async () => {
    state.user = { id: "u1" }
    state.rpc = { data: [{ moment_id: "m1", fmv_usd: 0, is_manual_override: false, collection_id: TOPSHOT_UUID }], error: null }
    const res = await GET(req("https://t/api/profile/hero-moment"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hero).toBeNull()
    expect(body.reason).toBe("no_fmv")
  })
})
