import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/market (the RPC Index). Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder over
// topshot_market_index_daily. Pins the tier-allowlist 400 guard, the happy/empty
// path with echoed filters, and the rpc-error → 500 path.

const tables: Record<string, { data: any; error: any }> = {}

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    const b: any = {
      select: () => b, eq: () => b, gte: () => b, gt: () => b, lte: () => b,
      lt: () => b, ilike: () => b, order: () => b, limit: () => b, range: () => b, in: () => b,
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  const admin: any = { from: (t: string) => make(t), rpc: async () => ({ data: null, error: null }) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/market/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/market"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/market", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${base}?tier=SUPER`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("returns rows with echoed filters on the happy path", async () => {
    tables.topshot_market_index_daily = { data: [{ d: "2026-07-01", tier: "ALL", sales: 550, median_px: 0.9 }], error: null }
    const res = await GET(req(`${base}?tier=all&days=30`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.filters).toMatchObject({ tier: "ALL", days: 30 })
    expect(body.meta.source).toBe("topshot_market_index_daily")
  })

  it("returns an empty rows array when the view has nothing", async () => {
    tables.topshot_market_index_daily = { data: [], error: null }
    const res = await GET(req(base))
    expect(res.status).toBe(200)
    expect((await res.json()).rows).toEqual([])
  })

  it("500s on a view query error", async () => {
    tables.topshot_market_index_daily = { data: null, error: { message: "index down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("index down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })

  // Regression (2026-08-01): a non-numeric ?days used to make `days` NaN, and
  // `new Date(Date.now() - NaN).toISOString()` throws a RangeError BEFORE the DB
  // is touched → 500. The NaN-safe clamp now degrades to the 120-day default.
  it("degrades a non-numeric ?days to the default instead of throwing", async () => {
    tables.topshot_market_index_daily = { data: [], error: null }
    const res = await GET(req(`${base}?days=abc`))
    expect(res.status).toBe(200)
    expect((await res.json()).meta.filters.days).toBe(120)
  })
})
