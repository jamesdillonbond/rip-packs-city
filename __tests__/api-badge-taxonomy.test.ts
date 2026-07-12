import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for POST /api/badge-taxonomy. Mocks
// @supabase/supabase-js's createClient — the handler calls
// supabase.rpc("get_badge_display_metadata", ...) and re-keys the returned
// { canonicalTitle: BadgeMeta } map by the normalized badge key. Pins the
// empty-titles guard (no DB touch → { taxonomy: {} }), a bad-body guard, and
// one mocked happy path asserting the normalized-key re-mapping. Titles are
// kept unique per test because the route keeps a module-level taxonomy cache.

const state: { data: any; error: any } = { data: {}, error: null }

vi.mock("@supabase/supabase-js", () => {
  return {
    createClient: () => ({
      rpc: async (_name: string, _args: any) => ({ data: state.data, error: state.error }),
    }),
  }
})

import { POST } from "@/app/api/badge-taxonomy/route"

const req = (body: any) =>
  ({
    json: async () => {
      if (body === "__throw__") throw new Error("bad json")
      return body
    },
  }) as any

beforeEach(() => {
  state.data = {}
  state.error = null
})

describe("POST /api/badge-taxonomy", () => {
  it("returns an empty taxonomy when titles is empty (DB untouched)", async () => {
    const res = await POST(req({ titles: [] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ taxonomy: {} })
  })

  it("returns an empty taxonomy for a bad/absent body", async () => {
    const res = await POST(req("__throw__"))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ taxonomy: {} })
  })

  it("re-keys the RPC result by the normalized badge key", async () => {
    state.data = {
      "Top Shot Debut": {
        title: "Top Shot Debut",
        category: "milestone",
        color_family: "blue",
        icon_url: null,
        priority: 1,
        description: null,
      },
    }
    const res = await POST(req({ titles: ["Top Shot Debut!"] }))
    expect(res.status).toBe(200)
    const body = await res.json()
    // normalizeBadgeKey strips non-alphanumerics + lowercases → "topshotdebut"
    expect(body.taxonomy.topshotdebut).toMatchObject({ title: "Top Shot Debut", category: "milestone" })
  })

  it("omits titles the RPC has no badge for (negative cache)", async () => {
    state.data = {} // RPC resolves nothing for this title
    const res = await POST(req({ titles: ["Totally Unknown Badge XYZ"] }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ taxonomy: {} })
  })
})
