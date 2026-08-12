import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/allday-scarcity. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder over
// allday_scarcity_board. Pins the sort-allowlist 400 guard, the happy/empty
// path, and the rpc-error → 500 path.

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

import { GET } from "@/app/api/public/insights/allday-scarcity/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/allday-scarcity"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/allday-scarcity", () => {
  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${base}?sort=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns rows with echoed filters on the happy path", async () => {
    tables.allday_scarcity_board = { data: [{ external_id: "1:2", mint_count: 25 }], error: null }
    const res = await GET(req(`${base}?tier=legendary&set=cosmic&max_mint=50&sort=mint&limit=10`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.filters).toMatchObject({ tier: "legendary", set: "cosmic", max_mint: 50, sort: "mint", limit: 10 })
    expect(body.meta.source).toBe("allday_scarcity_board")
  })

  it("500s on a view query error", async () => {
    tables.allday_scarcity_board = { data: null, error: { message: "board down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("board down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})
