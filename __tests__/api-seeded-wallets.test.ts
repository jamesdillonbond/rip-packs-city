import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/seeded-wallets. Fully public — no auth
// guard. Optional ?tag= / ?username= filters narrow the query; every request
// hits seeded_wallets. The Supabase client is built via createClient at module
// load (mocked). Pins the happy path (returns {wallets}), the error → 500, and
// the filtered variants (ilike/contains are chainable no-ops in the mock).

const state: { result: any } = { result: { data: [], error: null } }

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    ilike: () => b,
    contains: () => b,
    order: () => b,
    then: (resolve: any) => resolve(state.result),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/seeded-wallets/route"

const req = (url: string) => ({ nextUrl: new URL(url), url }) as any

beforeEach(() => {
  state.result = { data: [], error: null }
})

describe("GET /api/seeded-wallets", () => {
  it("returns the wallets list (empty)", async () => {
    state.result = { data: [], error: null }
    const res = await GET(req("https://t/api/seeded-wallets"))
    expect(res.status).toBe(200)
    expect((await res.json()).wallets).toEqual([])
  })

  it("returns wallets and applies username/tag filters", async () => {
    state.result = { data: [{ username: "trevor", wallet_address: "0x1", priority: 1 }], error: null }
    const res = await GET(req("https://t/api/seeded-wallets?username=trevor&tag=whale"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallets).toHaveLength(1)
    expect(body.wallets[0].username).toBe("trevor")
  })

  it("500s on a query error", async () => {
    state.result = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/seeded-wallets"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
