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
    const body = await res.json()
    // The driver's own text must never reach an anon caller (deep-audit D3):
    // these are PUBLIC routes, so a Postgres message here is a leak.
    expect(body.error).not.toContain("stats down")
    expect(body.code).toBe("internal")
    expect(body.retryable).toBe(false)
  })

  it("clamps a non-numeric ?limit to the default (never NaN → PostgREST 400)", async () => {
    const res = await GET(req(`${base}?limit=abc`))
    expect(res.status).toBe(200)
    // With the `?? "50"` bug the limit is NaN, which JSON-serializes to null;
    // the `|| 50` guard must yield the numeric default instead.
    expect((await res.json()).meta.filters.limit).toBe(50)
  })

  // 2026-10-26 (All Day ↔ Top Shot parity, pass 4): ?collection=nfl-all-day reads All Day's own views; an unknown
  // collection is refused — Top Shot's trophies under another collection's name would be substitution.
  it("?collection=nfl-all-day reads the All Day views, never Top Shot's", async () => {
    tables.topshot_first_mint_trophies = { data: [{ external_id: "8:133", player_name: "LeBron James" }], error: null }
    tables.topshot_first_mint_trophy_stats = { data: [{ trophies_90d: 524 }], error: null }
    tables.allday_first_mint_trophies = { data: [{ external_id: "445", player_name: "Richard Sherman", multiplier: 1589.4 }], error: null }
    tables.allday_first_mint_trophy_stats = { data: [{ trophies_90d: 27 }], error: null }
    const res = await GET(req(`${base}?collection=nfl-all-day`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.collection).toBe("nfl-all-day")
    expect(body.meta.sources).toEqual(["allday_first_mint_trophy_stats", "allday_first_mint_trophies"])
    expect(body.stats).toEqual({ trophies_90d: 27 })
    expect(body.trophies.map((t: any) => t.player_name)).toEqual(["Richard Sherman"])
    expect(JSON.stringify(body)).not.toContain("LeBron")
  })

  it("no collection param still means Top Shot", async () => {
    const body = await (await GET(req(base))).json()
    expect(body.meta.collection).toBe("nba-top-shot")
  })

  it("an unknown collection is a 400 with no rows and no other collection's name", async () => {
    tables.topshot_first_mint_trophies = { data: [{ external_id: "8:133", player_name: "LeBron James" }], error: null }
    for (const c of ["candy_mlb", "disney-pinnacle", "__proto__", ""]) {
      const res = await GET(req(`${base}?collection=${encodeURIComponent(c)}`))
      expect(res.status).toBe(400)
      const text = JSON.stringify(await res.json())
      expect(text).not.toContain("LeBron")
      expect(text).not.toContain("trophies\"")
    }
  })
})
