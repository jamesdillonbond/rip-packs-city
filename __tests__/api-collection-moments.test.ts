import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/collection-moments. No auth. The `wallet`
// param is required (400 if absent). A raw 0x…(18-char) address resolves without
// any network call, so the happy path only needs the Supabase RPC seam mocked:
// get_wallet_moments_with_fmv (page + count), get_wallet_total_fmv (thenable),
// and get_acquisition_stats. A raw RPC error on the primary call → 500.

const state: { moments: any; momentsError: any; totalFmv: any; resolve: any } = {
  moments: { moments: [], total_count: 0 },
  momentsError: null,
  totalFmv: 0,
  resolve: { data: null, error: null },
}
const gqlMock = vi.fn<(...a: unknown[]) => Promise<unknown>>(async () => { throw new Error("public-api.nbatopshot.com is decommissioned (CF 530)") })
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: (...a: unknown[]) => gqlMock(...(a as [])) }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (name: string) => {
      if (name === "get_wallet_moments_with_fmv") {
        return { data: state.moments, error: state.momentsError }
      }
      if (name === "get_wallet_total_fmv") return { data: state.totalFmv, error: null }
      if (name === "get_acquisition_stats") return { data: null, error: null }
      if (name === "resolve_topshot_username") return state.resolve
      return { data: null, error: null }
    },
    from: () => ({ select: () => ({ eq: () => ({ single: async () => ({ data: null }) }) }) }),
  },
}))

import { GET } from "@/app/api/collection-moments/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any
const WALLET = "0xbd94cade097e50ac" // 0x + 16 hex = 18 chars → resolves locally

beforeEach(() => {
  state.moments = { moments: [], total_count: 0 }
  state.momentsError = null
  state.totalFmv = 0
  state.resolve = { data: null, error: null }
  gqlMock.mockClear()
})

describe("GET /api/collection-moments", () => {
  it("400s when the wallet param is missing", async () => {
    const res = await GET(req("https://t/api/collection-moments"))
    expect(res.status).toBe(400)
    expect((await res.json()).message).toContain("wallet parameter is required")
  })

  it("returns an empty page for a wallet with no cached moments", async () => {
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moments).toEqual([])
    expect(body.total_count).toBe(0)
    expect(body.wallet).toBe(WALLET)
    expect(body.total_pages).toBe(0)
  })

  it("resolves a USERNAME through the cached ladder without touching the dead Top Shot host (2026-09-04)", async () => {
    // Every username search on the collection tab 500'd for a week: the route's
    // own resolver went straight to public-api.nbatopshot.com (CF 530 since
    // ~08-28). The wallet_usernames ladder knows the founder's name.
    state.resolve = { data: { found: true, wallet_address: "bd94cade097e50ac", source: "wallet_usernames" }, error: null }
    const res = await GET(req("https://t/api/collection-moments?wallet=jamesdillonbond"))
    expect(res.status).toBe(200)
    expect((await res.json()).wallet).toBe(WALLET)
    expect(gqlMock).not.toHaveBeenCalled()
  })

  it("a username the cache does not know still goes to the live host; when that host is DOWN the answer is a 503 'lookup unavailable', not 'check the spelling' and not a 500 (control)", async () => {
    state.resolve = { data: { found: false }, error: null }
    const res = await GET(req("https://t/api/collection-moments?wallet=nobody-here"))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe("upstream_unavailable")
    expect(body.error).toContain("wallet address")
    expect(gqlMock).toHaveBeenCalledTimes(1)
  })

  it("a username the live host answers 'no such user' for is the fixed 400 not_found copy", async () => {
    state.resolve = { data: { found: false }, error: null }
    gqlMock.mockImplementationOnce(async () => ({ getUserProfileByUsername: { publicInfo: { flowAddress: null } } }))
    const res = await GET(req("https://t/api/collection-moments?wallet=nobody-here"))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe("not_found")
  })

  it("500s when the moments RPC returns an error", async () => {
    state.momentsError = { message: "rpc boom" }
    const res = await GET(req(`https://t/api/collection-moments?wallet=${WALLET}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })
})
