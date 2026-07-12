import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/search-editions. Cookie-auth gated via
// getCurrentUser (null → 401 "Authentication required"). Then a query guard:
// q missing or <2 chars → {ok:true, editions:[]} without a DB hit. Happy path:
// authed + q>=2 → supabaseAdmin editions search mapped to the response shape.

const state: { user: any; result: any } = { user: null, result: { data: [], error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    or: () => b,
    not: () => b,
    order: () => b,
    limit: () => b,
    then: (resolve: any) => resolve(state.result),
  }
  const admin: any = { from: () => b }
  return { supabaseAdmin: admin }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => state.user,
}))

import { GET } from "@/app/api/search-editions/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.user = null
  state.result = { data: [], error: null }
})

describe("GET /api/search-editions", () => {
  it("401s when unauthenticated", async () => {
    state.user = null
    const res = await GET(req("https://t/api/search-editions?q=lebron"))
    expect(res.status).toBe(401)
    expect((await res.json()).error).toBe("Authentication required")
  })

  it("returns empty editions when q is missing or too short", async () => {
    state.user = { id: "u1" }
    const res = await GET(req("https://t/api/search-editions?q=a"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editions).toEqual([])
  })

  it("500s on a query error", async () => {
    state.user = { id: "u1" }
    state.result = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/search-editions?q=lebron"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("maps rows to the edition search shape for an authed user", async () => {
    state.user = { id: "u1" }
    state.result = {
      data: [{ id: "e1", external_id: "73:2785", player_name: "LeBron", set_name: "Base", collection_id: "c1" }],
      error: null,
    }
    const res = await GET(req("https://t/api/search-editions?q=lebron&limit=5"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.editions[0]).toEqual({
      edition_id: "e1",
      edition_key: "73:2785",
      player_name: "LeBron",
      set_name: "Base",
      collection_id: "c1",
    })
  })
})
