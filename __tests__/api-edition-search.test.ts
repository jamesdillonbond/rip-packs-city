import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/edition-search. No auth gate. Mocks
// @/lib/supabase supabaseAdmin with a thenable builder — the handler builds
// .from().select().limit() then conditionally .eq()/.ilike() and awaits the
// query. Pins the empty-`q` short-circuit, the happy path (mapped rows), and
// the query-error → 500.

const state: { data: any; error: any } = { data: [], error: null }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    limit: () => b,
    eq: () => b,
    ilike: () => b,
    then: (resolve: any) => resolve({ data: state.data, error: state.error }),
  }
  return { supabaseAdmin: { from: () => b } }
})

import { GET } from "@/app/api/edition-search/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = []
  state.error = null
})

describe("GET /api/edition-search", () => {
  it("returns an empty result set for a blank query", async () => {
    const res = await GET(req("https://t/api/edition-search"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ results: [] })
  })

  it("maps rows for a player-name query", async () => {
    state.data = [
      { id: "u1", external_id: "84:2892", player_name: "Damian Lillard", set_name: "Base", tier: "COMMON", collection_id: "c1" },
    ]
    const res = await GET(req("https://t/api/edition-search?q=Lillard"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.results).toHaveLength(1)
    expect(body.results[0]).toMatchObject({ external_id: "84:2892", player_name: "Damian Lillard" })
  })

  it("500s on a query error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req("https://t/api/edition-search?q=84:2892"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })
})
