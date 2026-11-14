import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/public/insights/rookie-sales. Mocks supabaseAdmin per table; the route must
// 400 a class it does not serve, assemble the ranked board, and turn ANY failed read into a 5xx —
// never an empty board or an undercounted class total.

const tables: Record<string, { data: unknown; error: unknown }> = {}

vi.mock("@/lib/supabase", () => {
  const make = (table: string) => {
    const payload = () => tables[table] ?? { data: [], error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const b: any = {
      select: () => b, eq: () => b, gt: () => b, in: () => b, order: () => b, limit: () => b, range: () => b,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: any) => resolve(payload()),
    }
    return b
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const admin: any = { from: (t: string) => make(t) }
  return { supabaseAdmin: admin, supabase: admin }
})

import { GET } from "@/app/api/public/insights/rookie-sales/route"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const req = (u: string) => ({ url: u, nextUrl: new URL(u) }) as any
const base = "https://t/api/public/insights/rookie-sales"

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  tables.topshot_2026_rookie_players = { data: [{ player_name: "AJ Dybantsa" }], error: null }
  tables.editions = { data: [{ id: "e1", player_name: "AJ Dybantsa", team_name: "Washington Wizards", external_id: "281:9324", set_name: "Rookie Debut" }], error: null }
  tables.sales = { data: [{ id: "s1", edition_id: "e1", price_usd: "113.00", nft_id: "53013846", sold_at: "2026-11-14T18:00:00Z" }], error: null }
  tables.espn_athletes = { data: [{ espn_id: "5142718", display_name: "AJ Dybantsa" }], error: null }
  tables.player_game_stats = {
    data: [{ espn_id: "5142718", event_id: "1", game_date: "2026-11-12", season: 2027, season_type: 2, did_not_play: false, stats: { points: "5", rebounds: "8", assists: "4" } }],
    error: null,
  }
})

describe("GET /api/public/insights/rookie-sales", () => {
  it("400s a class it does not serve", async () => {
    const res = await GET(req(`${base}?class=2025`))
    expect(res.status).toBe(400)
  })

  it("returns the ranked board with pick, season line, image id and totals", async () => {
    const res = await GET(req(`${base}?limit=10`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totals).toEqual({ players: 1, sales: 1, gmv_usd: 113 })
    expect(body.rows[0]).toMatchObject({
      rank: 1, player_name: "AJ Dybantsa", team_name: "Washington Wizards", draft_pick: 1,
      sales: 1, gmv_usd: 113, image_nft_id: "53013846",
      season: { games: 1, ppg: 5, rpg: 8, apg: 4, through: "2026-11-12" },
    })
    expect(body.meta.stats_through).toBe("2026-11-12")
  })

  it.each(["topshot_2026_rookie_players", "editions", "sales", "espn_athletes", "player_game_stats"])(
    "a failed %s read is a 5xx, not an empty or partial board",
    async (table) => {
      tables[table] = { data: null, error: { message: "boom" } }
      const res = await GET(req(base))
      expect(res.status).toBeGreaterThanOrEqual(500)
      const body = await res.json()
      expect(body.rows).toBeUndefined()
      expect(body.totals).toBeUndefined()
    },
  )
})
