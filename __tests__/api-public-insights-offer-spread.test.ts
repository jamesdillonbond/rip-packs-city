import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/public/insights/offer-spread. Mocks
// @/lib/supabase's supabaseAdmin as a per-table thenable builder over
// topshot_offer_ask_spread. Pins the tier / min_ask / sort 400 guards, the
// happy/empty path with echoed filters, and the rpc-error → 500 path.

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

import { GET } from "@/app/api/public/insights/offer-spread/route"

const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/offer-spread"

beforeEach(() => { for (const k of Object.keys(tables)) delete tables[k] })

describe("GET /api/public/insights/offer-spread", () => {
  it("400s on an invalid tier", async () => {
    const res = await GET(req(`${base}?tier=SUPER`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("tier must be one of")
  })

  it("400s on a negative min_ask", async () => {
    const res = await GET(req(`${base}?min_ask=-1`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("min_ask must be a non-negative number")
  })

  it("400s on an invalid sort", async () => {
    const res = await GET(req(`${base}?sort=bogus`))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toContain("sort must be one of")
  })

  it("returns rows with echoed filters on the happy path", async () => {
    tables.topshot_offer_ask_spread = { data: [{ external_id: "1:2", highest_offer: 10, low_ask: 12 }], error: null }
    const res = await GET(req(`${base}?tier=rare&bid_meets_ask=true&sort=spread&limit=20`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.rows).toHaveLength(1)
    expect(body.meta.total_rows).toBe(1)
    expect(body.meta.filters).toMatchObject({ tier: "RARE", bid_meets_ask: true, sort: "spread", limit: 20 })
  })

  it("500s on a view query error", async () => {
    tables.topshot_offer_ask_spread = { data: null, error: { message: "spread down" } }
    const res = await GET(req(base))
    expect(res.status).toBe(500)
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("spread down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })
})

// 2026-10-26 (All Day parity): the board reads allday_offer_ask_spread for collection=nfl-all-day. An unknown
// collection is refused, never answered with Top Shot rows (substitution); an ABSENT param stays Top Shot.
describe("GET /api/public/insights/offer-spread — collection", () => {
  it("collection=nfl-all-day reads the All Day view, never Top Shot's", async () => {
    tables.allday_offer_ask_spread = { data: [{ external_id: "6112", highest_offer: 300, low_ask: 260 }], error: null }
    tables.topshot_offer_ask_spread = { data: [{ external_id: "1:2" }], error: null }
    const body = await (await GET(req(`${base}?collection=nfl-all-day&tier=uncommon`))).json()
    expect(body.rows.map((r: any) => r.external_id)).toEqual(["6112"])
    expect(body.meta).toMatchObject({ source: "allday_offer_ask_spread", collection: "nfl-all-day" })
    expect(body.meta.filters.tier).toBe("UNCOMMON")
  })
  it("tiers are per collection: FANDOM is not an All Day tier, UNCOMMON not a Top Shot one", async () => {
    expect((await GET(req(`${base}?collection=nfl-all-day&tier=FANDOM`))).status).toBe(400)
    expect((await GET(req(`${base}?tier=UNCOMMON`))).status).toBe(400)
  })
  it("an unknown collection is a 400, not Top Shot rows", async () => {
    tables.topshot_offer_ask_spread = { data: [{ external_id: "1:2" }], error: null }
    const res = await GET(req(`${base}?collection=candy-mlb`))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain("1:2")
  })
  it("no collection param stays Top Shot", async () => {
    tables.topshot_offer_ask_spread = { data: [{ external_id: "1:2" }], error: null }
    const body = await (await GET(req(base))).json()
    expect(body.meta.collection).toBe("nba-top-shot")
  })
})
