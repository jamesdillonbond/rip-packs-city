import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-readiness. No auth, no required
// params (returns the full readiness map by default; ?collection scopes it). Thin
// wrapper over the collection_readiness() RPC — we mock that seam for the happy
// path, the scoped path (asserting the slug is normalized to the DB underscore
// form), and the error → 500 path.

const state: { data: any; error: any; lastParams: any } = { data: {}, error: null, lastParams: undefined }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (_name: string, params: any) => {
      state.lastParams = params
      return { data: state.data, error: state.error }
    },
  },
}))

import { GET } from "@/app/api/collection-readiness/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.data = {}
  state.error = null
  state.lastParams = undefined
})

describe("GET /api/collection-readiness", () => {
  it("returns the full readiness map with no collection filter", async () => {
    state.data = { "nba-top-shot": { ready: true } }
    const res = await GET(req("https://t/api/collection-readiness"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ "nba-top-shot": { ready: true } })
    expect(state.lastParams).toEqual({})
  })

  it("normalizes a hyphen slug to the DB underscore slug when scoped", async () => {
    state.data = { ok: true }
    const res = await GET(req("https://t/api/collection-readiness?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(state.lastParams).toEqual({ p_slug: "nba_top_shot" })
  })

  it("500s on an RPC error", async () => {
    state.error = { message: "db down" }
    const res = await GET(req("https://t/api/collection-readiness"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Query failed")
  })
})
