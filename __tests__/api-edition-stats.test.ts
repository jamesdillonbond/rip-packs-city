import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/edition-stats. Mocks @/lib/supabase's
// supabaseAdmin: a chained .from().select().eq().maybeSingle() edition lookup + a
// query_sql rpc for the sale-pattern buckets. Pins the guards, the
// bestTimeToBuy selection (cheapest buckets with >=2 sales), and that the
// patterns are read via query_sql (RETURNS jsonb rows) NOT execute_sql
// (RETURNS void — which always yielded null → empty analysis, the bug).

const state: { edition: any; patterns: any; lastRpc: string | null } = {
  edition: { data: null },
  patterns: { data: [] },
  lastRpc: null,
}

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    eq: () => b,
    // Both are stubbed so this mock cannot silently pass when the route changes
    // which one it calls — the route moved from .single() to .maybeSingle() on
    // 2026-08-21 so that a zero-row miss and a failed read stop sharing an
    // outcome, and a mock that knew only .single() would have returned undefined
    // and failed in a way that looked like a route bug.
    single: async () => state.edition,
    maybeSingle: async () => state.edition,
  }
  const admin: any = {
    from: () => b,
    rpc: async (name: string) => {
      state.lastRpc = name
      return state.patterns
    },
  }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/edition-stats/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.edition = { data: null }
  state.patterns = { data: [] }
  state.lastRpc = null
})

describe("GET /api/edition-stats", () => {
  it("400s without editionKey", async () => {
    expect((await GET(req("https://t/api/edition-stats"))).status).toBe(400)
  })

  it("does NOT report a failed lookup as a missing edition", async () => {
    // "Edition not found" is a claim about the CATALOGUE, and a failed read is
    // not evidence for it. With the error swallowed this 404'd, telling a reader
    // that a moment they were looking at does not exist. The 404 below is the
    // control: absent and unreadable must not share an outcome.
    state.edition = { data: null, error: { message: "statement timeout" } }
    const res = await GET(req("https://t/api/edition-stats?editionKey=73:2785"))
    expect(res.status).not.toBe(404)
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("404s when the edition is not found", async () => {
    state.edition = { data: null, error: null }
    const res = await GET(req("https://t/api/edition-stats?editionKey=73:2785"))
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe("Edition not found")
  })

  it("returns bestTimeToBuy from the cheapest buckets with >=2 sales", async () => {
    state.edition = { data: { id: "uuid-1" } }
    state.patterns = {
      data: [
        { dow: 1, hour: 9, avg_price: 10, sale_count: 5 }, // cheapest, qualifies
        { dow: 2, hour: 14, avg_price: 12, sale_count: 1 }, // too few sales, excluded from bestTimeToBuy
        { dow: 3, hour: 20, avg_price: 15, sale_count: 3 }, // qualifies
      ],
    }
    const res = await GET(req("https://t/api/edition-stats?editionKey=73:2785"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.editionKey).toBe("73:2785")
    expect(body.allPatterns).toHaveLength(3)
    // bestTimeToBuy keeps only sale_count>=2 buckets, cheapest first
    expect(body.bestTimeToBuy).toHaveLength(2)
    expect(body.bestTimeToBuy[0]).toMatchObject({ dow: 1, hour: 9, label: "Monday 9:00" })
    expect(body.bestTimeToBuy.every((b: any) => b.sale_count >= 2)).toBe(true)
    // Pin the fix: patterns must come from query_sql (jsonb rows), not execute_sql (void).
    expect(state.lastRpc).toBe("query_sql")
  })
})
