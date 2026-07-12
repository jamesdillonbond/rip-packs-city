import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/first-mint. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder; the handler
// Promise.all's the trophy_stats single-row + the ranked trophies list. No auth
// guard — pins the happy/empty shape and a per-leg error → 500.

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

import { GET } from "@/app/api/public/insights/first-mint/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/first-mint"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/first-mint", () => {
  it("returns null stats + empty trophies when both views are empty", async () => {
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toBeNull()
    expect(body.trophies).toEqual([])
    expect(body.meta.sources).toContain("topshot_first_mint_trophies")
  })

  it("assembles stats + trophies with echoed filters", async () => {
    tables.topshot_first_mint_trophy_stats = { data: [{ n_first_mints: 452, avg_multiplier: 15.8 }], error: null }
    tables.topshot_first_mint_trophies = { data: [{ external_id: "8:133", multiplier: 248.7 }], error: null }
    const res = await GET(req(`${base}?min_multiplier=10&limit=25&tier=fandom`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stats).toEqual({ n_first_mints: 452, avg_multiplier: 15.8 })
    expect(body.trophies).toHaveLength(1)
    expect(body.meta.filters).toMatchObject({ limit: 25, min_multiplier: 10, tier: "FANDOM" })
  })

  it("500s when the stats leg errors", async () => {
    tables.topshot_first_mint_trophy_stats = { data: null, error: { message: "stats down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("stats down")
  })
})
