import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/trophy-slabs. The handler reads
// ?username / ?mine, then calls one of two RPCs on either the anon client
// (supabase) or the admin client (supabaseAdmin) from @/lib/supabase, and
// gates ?mine=1 behind getCurrentUser() from @/lib/auth/supabase-server.
// Mocks both modules and pins: the missing-param 400 guard, the unauthenticated
// 401 guard, the owner/public happy paths (normalized {slabs}), and the
// error-swallow paths that return {slabs: []}.

const state: {
  user: any
  mineRpc: { data: any; error: any }
  publicRpc: { data: any; error: any }
} = {
  user: null,
  mineRpc: { data: [], error: null },
  publicRpc: { data: [], error: null },
}

vi.mock("@/lib/supabase", () => {
  const admin: any = { rpc: async () => state.mineRpc }
  const anon: any = { rpc: async () => state.publicRpc }
  return { supabase: anon, supabaseAdmin: admin }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/profile/trophy-slabs/route"

const req = (url: string) => ({ url, nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.mineRpc = { data: [], error: null }
  state.publicRpc = { data: [], error: null }
})

describe("GET /api/profile/trophy-slabs", () => {
  it("400s when neither username nor mine is provided", async () => {
    const res = await GET(req("https://t/api/profile/trophy-slabs"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("Provide ?username=<u> or ?mine=1")
  })

  it("401s on ?mine=1 when not authenticated", async () => {
    state.user = null
    const res = await GET(req("https://t/api/profile/trophy-slabs?mine=1"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("not_authenticated")
  })

  it("returns the owner's normalized slabs on ?mine=1 when authenticated", async () => {
    state.user = { id: "user-1" }
    state.mineRpc = { data: [{ id: 1, slot: 1, moment_id: "m1" }], error: null }
    const res = await GET(req("https://t/api/profile/trophy-slabs?mine=1"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slabs).toHaveLength(1)
    expect(body.slabs[0]).toMatchObject({ id: 1, slot: 1, moment_id: "m1" })
  })

  it("swallows an owner RPC error into {slabs: []}", async () => {
    state.user = { id: "user-1" }
    state.mineRpc = { data: null, error: { message: "boom" } }
    const res = await GET(req("https://t/api/profile/trophy-slabs?mine=1"))
    expect(res.status).toBe(200)
    expect((await res.json()).slabs).toEqual([])
  })

  it("returns normalized public slabs for ?username=<u>", async () => {
    state.publicRpc = {
      data: [
        { id: 5, slot: 2, moment_id: "m5" },
        { id: 6, slot: 3, moment_id: "m6" },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/profile/trophy-slabs?username=trevor"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slabs).toHaveLength(2)
  })

  it("swallows a public RPC error into {slabs: []}", async () => {
    state.publicRpc = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/trophy-slabs?username=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).slabs).toEqual([])
  })

  it("normalizes a non-array RPC result to []", async () => {
    state.publicRpc = { data: { not: "an array" }, error: null }
    const res = await GET(req("https://t/api/profile/trophy-slabs?username=trevor"))
    expect((await res.json()).slabs).toEqual([])
  })
})
