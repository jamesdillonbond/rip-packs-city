import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/cache-refresh. This route is public (no
// bearer auth) but guards on the `wallet` (must start with 0x) and `collection`
// (must be a supported slug) params before any on-chain / DB work. We mock the
// FCL default export (@/lib/flow) so the zero-moments happy path returns without
// touching Supabase, and stub @onflow/types so the module imports cleanly.

const state: { ids: any; throwIds: boolean } = { ids: [], throwIds: false }

vi.mock("@/lib/chains/flow/flow", () => ({
  default: {
    query: async () => {
      if (state.throwIds) throw new Error("fcl down")
      return state.ids
    },
  },
}))
vi.mock("@onflow/types", () => ({ Address: "Address", UInt64: "UInt64" }))
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: () => ({}) }),
}))

import { GET } from "@/app/api/cache-refresh/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.ids = []
  state.throwIds = false
})

describe("GET /api/cache-refresh", () => {
  it("400s when wallet is missing", async () => {
    const res = await GET(req("https://t/api/cache-refresh"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("wallet param required")
  })

  it("400s when wallet does not start with 0x", async () => {
    const res = await GET(req("https://t/api/cache-refresh?wallet=deadbeef"))
    expect(res.status).toBe(400)
  })

  it("400s on an unsupported collection slug", async () => {
    const res = await GET(
      req("https://t/api/cache-refresh?wallet=0xbd94cade097e50ac&collection=bogus-chain")
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("Unsupported collection")
  })

  it("returns a clean zero-state when the wallet holds no on-chain moments", async () => {
    state.ids = []
    const res = await GET(req("https://t/api/cache-refresh?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.total_on_chain).toBe(0)
    expect(body.new_stubs_inserted).toBe(0)
  })

  it("502s when the FCL getIDs query throws", async () => {
    state.throwIds = true
    // The route awaits fcl.query(); a throw is caught → 502.
    const res = await GET(req("https://t/api/cache-refresh?wallet=0xbd94cade097e50ac"))
    expect(res.status).toBe(502)
  })
})
