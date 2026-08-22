import { describe, it, expect, beforeEach, vi } from "vitest"

const rec: { upserts: any[]; rpcCalls: any[] } = { upserts: [], rpcCalls: [] }

vi.mock("@/lib/supabase", () => {
  const admin: any = {
    from: () => admin,
    select: () => admin,
    eq: () => admin,
    maybeSingle: async () => ({ data: null, error: null }),
    upsert: async (row: any) => {
      rec.upserts.push(row)
      return { data: null, error: null }
    },
    rpc: async (name: string, args: any) => {
      rec.rpcCalls.push({ name, args })
      return { data: null, error: null }
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

// The builders are exercised on their own in lib-insights-boards.test.ts; here we
// stub them so the cron test drives warm/log behavior deterministically.
vi.mock("@/lib/insights/boards", () => ({
  fetchDealsDefault: vi.fn(async () => ({ payload: { rows: [{ id: 1 }] }, ok: true, rowCount: 1 })),
  fetchRookiesDefault: vi.fn(async () => ({ payload: { rows: [] }, ok: true, rowCount: 0 })),
  fetchFirstMintDefault: vi.fn(async () => ({ payload: { trophies: [] }, ok: false, rowCount: 0 })),
}))

vi.mock("@/lib/insights/candy-board", () => ({
  fetchCandyMlbDefault: vi.fn(async () => ({ payload: { initialRows: [{ id: 1 }] }, ok: true, rowCount: 1 })),
}))

vi.mock("@/lib/insights/panini-board", () => ({
  fetchPaniniSqueezeDefault: vi.fn(async () => ({ payload: { initialRows: [{ id: 2 }] }, ok: true, rowCount: 1 })),
}))

import { POST, GET } from "@/app/api/cron/refresh-insights-cache/route"

const req = (auth?: string) =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? auth ?? null : null) },
  }) as any

beforeEach(() => {
  rec.upserts = []
  rec.rpcCalls = []
  process.env.INGEST_SECRET_TOKEN = "test-token"
  process.env.CRON_SECRET = "cron-token"
})

describe("POST /api/cron/refresh-insights-cache", () => {
  it("401s without the ingest bearer", async () => {
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(rec.upserts).toHaveLength(0)
    expect(rec.rpcCalls).toHaveLength(0)
  })

  it("401s with a wrong bearer (matches neither secret)", async () => {
    const res = await POST(req("Bearer nope"))
    expect(res.status).toBe(401)
  })

  it("accepts the Vercel-cron CRON_SECRET bearer", async () => {
    const res = await POST(req("Bearer cron-token"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.pipeline).toBe("refresh-insights-cache")
  })

  it("warms the ok boards, skips the failing one, and logs a partial-but-ok run", async () => {
    const res = await POST(req("Bearer test-token"))
    const body = await res.json()
    // deals + rookies + candy-mlb + panini-squeeze are ok (written); first-mint ok:false.
    expect(body.warmed).toBe(4)
    expect(body.total).toBe(5)
    // A partial warm is still ok=true (>=1 board warmed) so a single saturated
    // board doesn't read as a red pipeline; the failure is recorded in p_error/extra.
    expect(body.ok).toBe(true)
    expect(rec.upserts.map((u) => u.board_key).sort()).toEqual([
      "candy-mlb",
      "deals",
      "panini-squeeze",
      "rookies",
    ])
    expect(rec.rpcCalls).toHaveLength(1)
    expect(rec.rpcCalls[0].name).toBe("log_pipeline_run")
    expect(rec.rpcCalls[0].args.p_pipeline).toBe("refresh-insights-cache")
    expect(rec.rpcCalls[0].args.p_rows_written).toBe(4)
    expect(rec.rpcCalls[0].args.p_ok).toBe(true)
    expect(rec.rpcCalls[0].args.p_error).toContain("first-mint")
    expect(rec.rpcCalls[0].args.p_extra.warmed).toBe(4)
  })

  it("GET works the same as POST (both auth-gated)", async () => {
    const res = await GET(req("Bearer test-token"))
    const body = await res.json()
    expect(body.pipeline).toBe("refresh-insights-cache")
  })
})
