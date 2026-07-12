import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/watchlist. Public ownerKey-keyed
// (owner_key text, no session gate — see CLAUDE.md "Deferred hardening"), so
// guards are param-based. Pins GET 400 (ownerKey required), the GET happy path
// (empty-editions branch → {items:[]}), POST 400 (ownerKey+editionId), and
// DELETE 400 (ownerKey+itemId).

const state: { result: any; single: any } = {
  result: { data: [], error: null },
  single: { data: null, error: null },
}

vi.mock("@/lib/supabase", () => {
  const build = () => {
    const b: any = {
      select: () => b, upsert: () => b, delete: () => b, eq: () => b, in: () => b, order: () => b,
      single: async () => state.single,
      then: (resolve: any) => resolve(state.result),
    }
    return b
  }
  const client: any = { from: () => build(), rpc: async () => state.result }
  return { supabase: client, supabaseAdmin: client }
})

vi.mock("@/lib/auth/supabase-server", () => ({
  getCurrentUser: async () => null,
}))

vi.mock("@/lib/rewards", () => ({ awardPoints: async () => undefined }))

import { GET, POST, DELETE } from "@/app/api/profile/watchlist/route"

const req = (url: string, body?: any) =>
  ({ nextUrl: new URL(url), json: async () => body }) as any

beforeEach(() => {
  state.result = { data: [], error: null }
  state.single = { data: null, error: null }
})

describe("/api/profile/watchlist", () => {
  it("GET 400s without ownerKey", async () => {
    const res = await GET(req("https://t/api/profile/watchlist"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("GET returns items on the happy path (no editions to enrich)", async () => {
    state.result = { data: [], error: null }
    const res = await GET(req("https://t/api/profile/watchlist?ownerKey=trevor"))
    expect(res.status).toBe(200)
    expect((await res.json()).items).toEqual([])
  })

  it("POST 400s without ownerKey and editionId", async () => {
    const res = await POST(req("https://t/api/profile/watchlist", { ownerKey: "trevor" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey and editionId required")
  })

  it("DELETE 400s without ownerKey and itemId", async () => {
    const res = await DELETE(req("https://t/api/profile/watchlist", { ownerKey: "trevor" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey and itemId required")
  })
})
