import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/rookies (2025 Rookie Class
// Index). Mocks @/lib/supabase's supabaseAdmin as a per-table thenable builder;
// the handler Promise.all's the cohort_stats single-row + the ranked index.
// Pins the sort-allowlist 400 guard, the happy/empty shape, and a leg error → 500.

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

import { GET } from "@/app/api/public/insights/rookies/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/rookies"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/rookies", () => {
  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${base}?sort=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("assembles cohort_stats + index rows with echoed filters", async () => {
    tables.topshot_2025_rookie_cohort_stats = { data: [{ total_gmv_30d: 147753 }], error: null }
    tables.topshot_2025_rookie_index = { data: [{ player_name: "Dylan Harper", gmv_30d: 21360 }], error: null }
    const res = await GET(req(`${base}?sort=lock&limit=50`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cohort_stats).toEqual({ total_gmv_30d: 147753 })
    expect(body.rows).toHaveLength(1)
    expect(body.meta.filters).toMatchObject({ sort: "lock", limit: 50 })
  })

  it("returns null cohort_stats + empty rows when both views are empty", async () => {
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.cohort_stats).toBeNull()
    expect(body.rows).toEqual([])
  })

  it("clamps a non-numeric ?limit to the default (never NaN → PostgREST 400)", async () => {
    const res = await GET(req(`${base}?limit=abc`))
    expect(res.status).toBe(200)
    // With the `?? "100"` bug the limit is NaN, which JSON-serializes to null;
    // the `|| 100` guard must yield the numeric default instead.
    expect((await res.json()).meta.filters.limit).toBe(100)
  })

  it("500s when the stats leg errors", async () => {
    tables.topshot_2025_rookie_cohort_stats = { data: null, error: { message: "stats down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("stats down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
