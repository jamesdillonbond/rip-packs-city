import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/portfolio-history.
// Public read with two branches: ?wallet → get_wallet_fmv_history RPC; ?ownerKey
// → portfolio_snapshots table; neither → 400. Pin the missing-param 400, the
// wallet-branch happy path, the ownerKey-branch happy path, and the wallet RPC
// error → 500. (POST upserts a snapshot — asserted as a function only.)

const state: { rpc: { data: any; error: any }; snapshots: { data: any; error: any } } = {
  rpc: { data: [], error: null },
  snapshots: { data: [], error: null },
}

function chain(getResult: () => any): any {
  const b: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (res: any, rej: any) => Promise.resolve(getResult()).then(res, rej)
        return () => b
      },
    }
  )
  return b
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: () => chain(() => state.snapshots),
    rpc: async () => state.rpc,
  },
}))

import { GET, POST } from "@/app/api/profile/portfolio-history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
  state.snapshots = { data: [], error: null }
})

describe("GET /api/profile/portfolio-history", () => {
  it("400s when neither ownerKey nor wallet is provided", async () => {
    const res = await GET(req("https://t/api/profile/portfolio-history"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey or wallet required")
  })

  it("returns the wallet FMV-history snapshots for ?wallet", async () => {
    state.rpc = { data: [{ day: "2026-07-01", total_fmv: 100 }], error: null }
    const res = await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc&days=30"))
    expect(res.status).toBe(200)
    expect((await res.json()).snapshots).toHaveLength(1)
  })

  it("500s when the wallet RPC errors", async () => {
    state.rpc = { data: null, error: { message: "db down" } }
    const res = await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("db down")
  })

  it("returns portfolio_snapshots for the ?ownerKey branch", async () => {
    state.snapshots = { data: [{ snapshot_date: "2026-07-01", total_fmv: 50 }], error: null }
    const res = await GET(req("https://t/api/profile/portfolio-history?ownerKey=trevor&days=7"))
    expect(res.status).toBe(200)
    expect((await res.json()).snapshots).toHaveLength(1)
  })

  it("exports a POST handler", () => {
    expect(typeof POST).toBe("function")
  })
})
