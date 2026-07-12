import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// Route integration test for GET /api/allday-lock-refresh.
// Guard: `wallet` query param required -> 400, before the Cadence unlocked-moment
// query. We pin the param guard AND the 2xx success path: with the wallet param
// present, fcl.query (mocked -> no unlocked moments) is diffed against the cached
// wallet_moments_cache rows, so a cached-but-not-on-chain moment is marked
// locked. The chainable Supabase stub lives in vi.hoisted (top-level route
// import triggers the mock factory before a plain const would initialise).

const h = vi.hoisted(() => {
  const state: { cacheRows: any } = { cacheRows: { data: [], error: null } }
  const sb: any = {
    from: () => sb,
    select: () => sb,
    eq: () => sb,
    in: () => sb,
    update: () => sb,
    then: (resolve: any) => resolve(state.cacheRows),
  }
  return { sb, state }
})

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: h.sb }))
vi.mock("@/lib/flow", () => ({ default: { query: async () => [] } }))

import { GET } from "@/app/api/allday-lock-refresh/route"

const req = (qs = "") => new NextRequest("https://t/api/allday-lock-refresh" + qs)

beforeEach(() => {
  h.state.cacheRows = { data: [], error: null }
})

describe("GET /api/allday-lock-refresh", () => {
  it("400s without a wallet param", async () => {
    const res = await GET(req())
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("wallet required")
  })

  it("200s and recomputes locks from the on-chain diff", async () => {
    h.state.cacheRows = { data: [{ moment_id: "m1", is_locked: false }], error: null }
    const res = await GET(req("?wallet=0xabc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xabc")
    expect(body.total_cached).toBe(1)
    expect(body.unlocked_onchain).toBe(0)
    expect(body.marked_locked).toBe(1)
    expect(body.marked_unlocked).toBe(0)
  })
})
