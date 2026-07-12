import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/cost-basis. No auth gate — pins the
// `wallet` 400 guard, the empty happy path, and the RPC-error → 500. Mocks
// @supabase/supabase-js createClient (the route builds its own service client):
// resolveCollectionId uses .from().select().eq().single(); the main read is
// rpc("get_wallet_cost_basis").

const state: { rpc: { data: any; error: any } } = { rpc: { data: [], error: null } }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    single: async () => ({ data: null }),
  }
  return {
    createClient: () => ({
      from: () => b,
      rpc: async () => state.rpc,
    }),
  }
})

import { GET } from "@/app/api/cost-basis/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
})

describe("GET /api/cost-basis", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req("https://t/api/cost-basis"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet param required")
  })

  it("returns an empty acquisitions list when the RPC yields no rows", async () => {
    state.rpc = { data: [], error: null }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xdeadbeef00000000"))
    expect(res.status).toBe(200)
    expect((await res.json()).acquisitions).toEqual([])
  })

  it("500s on an RPC error", async () => {
    state.rpc = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/cost-basis?wallet=0xdeadbeef00000000"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
