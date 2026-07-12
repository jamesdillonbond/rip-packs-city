import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/cross-collection. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder; the handler
// Promise.all's three tables (stats/cohort/set-overlap). Pins the sort-allowlist
// 400 guard, the happy/empty shape, and a per-leg error → 500.

const tables: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b, eq: () => b, gte: () => b, gt: () => b, lte: () => b,
      lt: () => b, ilike: () => b, order: () => b, limit: () => b, in: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  const admin: any = { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/cross-collection/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/cross-collection"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/cross-collection", () => {
  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${base}?sort=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("assembles stats + wallets + ts_set_overlap on the happy path", async () => {
    tables.cross_collection_cohort_stats = { data: [{ n_wallets: 143 }], error: null }
    tables.cross_collection_cohort_mat = { data: [{ wallet_address: "0xabc", total_moments: 500 }], error: null }
    tables.cross_collection_ts_set_overlap_mat = { data: [{ set_id: "s1", cohort_holders: 12 }], error: null }
    const res = await GET(req(`${base}?sort=fmv&limit=50`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toEqual({ n_wallets: 143 })
    expect(body.wallets).toHaveLength(1)
    expect(body.ts_set_overlap).toHaveLength(1)
    expect(body.meta.filters).toMatchObject({ sort: "fmv", limit: 50 })
  })

  it("returns null stats + empty arrays when all tables are empty", async () => {
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toBeNull()
    expect(body.wallets).toEqual([])
    expect(body.ts_set_overlap).toEqual([])
  })

  it("500s when the stats leg errors", async () => {
    tables.cross_collection_cohort_stats = { data: null, error: { message: "stats down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("stats down")
  })
})
