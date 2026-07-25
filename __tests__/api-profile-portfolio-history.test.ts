import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/profile/portfolio-history.
// Public read with two branches: ?wallet → get_wallet_fmv_history RPC; ?ownerKey
// → portfolio_snapshots table; neither → 400. Pin the missing-param 400, the
// wallet-branch happy path, the ownerKey-branch happy path, and the wallet RPC
// error → 500. (POST upserts a snapshot — asserted as a function only.)

const state: {
  rpc: { data: any; error: any }
  snapshots: { data: any; error: any }
  upserted: { data: any; error: any }
  upsertRows: any[]
  rpcArgs: any
} = {
  rpc: { data: [], error: null },
  snapshots: { data: [], error: null },
  upserted: { data: { id: "s1" }, error: null },
  upsertRows: [],
  rpcArgs: null,
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
    from() {
      let isUpsert = false
      const b: any = {
        select: () => b, eq: () => b, gte: () => b, order: () => b,
        upsert: (row: any) => { isUpsert = true; state.upsertRows.push(row); return b },
        single: async () => state.upserted,
        then: (resolve: any) => resolve(isUpsert ? state.upserted : state.snapshots),
      }
      return b
    },
    rpc: async (_n: string, args: any) => { state.rpcArgs = args; return state.rpc },
  },
}))

import { GET, POST } from "@/app/api/profile/portfolio-history/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.rpc = { data: [], error: null }
  state.snapshots = { data: [], error: null }
  state.upserted = { data: { id: "s1" }, error: null }
  state.upsertRows = []
  state.rpcArgs = null
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

  it("defaults snapshots to [] when the query returns null data", async () => {
    state.snapshots = { data: null, error: null }
    expect((await (await GET(req("https://t/api/profile/portfolio-history?ownerKey=t"))).json()).snapshots).toEqual([])
  })

  it("500s when the ownerKey snapshot read errors", async () => {
    state.snapshots = { data: null, error: { message: "snap down" } }
    expect((await GET(req("https://t/api/profile/portfolio-history?ownerKey=t"))).status).toBe(500)
  })

  it("caps ?days at 90 and defaults it to 30", async () => {
    await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc&days=999"))
    expect(state.rpcArgs.p_days).toBe(90)
    await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc"))
    expect(state.rpcArgs.p_days).toBe(30)
  })

  it("prefers the wallet branch when BOTH wallet and ownerKey are supplied", async () => {
    state.rpc = { data: [{ day: "d", total_fmv: 1 }], error: null }
    state.snapshots = { data: [{ a: 1 }, { b: 2 }], error: null }
    const body = await (await GET(req("https://t/api/profile/portfolio-history?wallet=0xabc&ownerKey=t"))).json()
    expect(body.snapshots).toHaveLength(1) // the RPC result, not the table read
  })
})

describe("POST /api/profile/portfolio-history", () => {
  const preq = (body: any) => ({ json: async () => body }) as any

  it("400s without an ownerKey", async () => {
    const res = await POST(preq({ totalFmv: 10 }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("ownerKey required")
  })

  it("upserts today's snapshot and returns the row", async () => {
    const body = await (await POST(preq({ ownerKey: "trevor", totalFmv: 250.5, momentCount: 12, walletCount: 2 }))).json()
    expect(body.snapshot).toEqual({ id: "s1" })
    const row = state.upsertRows[0]
    expect(row.owner_key).toBe("trevor")
    expect(row.total_fmv).toBe(250.5)
    expect(row.moment_count).toBe(12)
    expect(row.wallet_count).toBe(2)
    expect(row.snapshot_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it("zero-fills missing numeric fields rather than writing undefined", async () => {
    await POST(preq({ ownerKey: "trevor" }))
    const row = state.upsertRows[0]
    expect(row.total_fmv).toBe(0)
    expect(row.moment_count).toBe(0)
    expect(row.wallet_count).toBe(0)
  })

  it("500s on an upsert error", async () => {
    state.upserted = { data: null, error: { message: "upsert down" } }
    expect((await POST(preq({ ownerKey: "trevor" }))).status).toBe(500)
  })
})
