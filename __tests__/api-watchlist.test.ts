import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/watchlist. The route builds its own client via
// createClient(@supabase/supabase-js), so success paths mock THAT (not
// @/lib/supabase). GET fans out across watchlist/editions/fmv_snapshots/
// badge_editions/fmv_alerts — a per-table builder returns fixtures keyed by
// table; POST upserts (single) → 201.

const state: { user: any; tables: Record<string, any>; single: any } = {
  user: null,
  tables: {},
  single: { data: null, error: null },
}

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = (table: string) => {
    const b: any = {
      select: () => b, eq: () => b, in: () => b, order: () => b,
      upsert: () => b, delete: () => b,
      single: async () => state.single,
      then: (resolve: any) => resolve(state.tables[table] ?? { data: [], error: null }),
    }
    return b
  }
  return { createClient: () => ({ from: (t: string) => makeBuilder(t) }) }
})
vi.mock("@/lib/auth/supabase-server", () => ({ getCurrentUser: async () => state.user }))
vi.mock("@/lib/rewards", () => ({ awardPoints: async () => undefined }))

import { GET, POST } from "@/app/api/watchlist/route"

const get = (qs: string) => GET({ nextUrl: new URL(`https://t/api/watchlist?${qs}`) } as any)
const post = (body: any) => POST(new Request("https://t/api/watchlist", { method: "POST", body: JSON.stringify(body) }) as any)

beforeEach(() => {
  state.user = null
  state.tables = {}
  state.single = { data: null, error: null }
})

describe("/api/watchlist guards", () => {
  it("GET 400s without owner_key", async () => {
    expect((await get("")).status).toBe(400)
  })
  it("POST 400s without owner_key", async () => {
    expect((await post({ edition_key: "73:2785" })).status).toBe(400)
  })
  it("POST 400s without edition_key", async () => {
    expect((await post({ owner_key: "trevor" })).status).toBe(400)
  })
})

describe("/api/watchlist success paths", () => {
  it("GET 200s with [] when the owner has no watchlist rows", async () => {
    state.tables.watchlist = { data: [], error: null }
    const res = await get("owner_key=nobody")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })

  it("GET 200s and enriches a watchlist row with fmv + discount", async () => {
    state.tables.watchlist = { data: [{ edition_key: "73:2785", owner_key: "trevor" }], error: null }
    state.tables.editions = { data: [{ id: "ed-uuid", external_id: "73:2785" }], error: null }
    state.tables.fmv_snapshots = { data: [{ edition_id: "ed-uuid", fmv_usd: 100, computed_at: "2026-07-01" }], error: null }
    state.tables.badge_editions = { data: [{ edition_key: "73:2785", low_ask: 80 }], error: null }
    state.tables.fmv_alerts = { data: [{ edition_key: "73:2785" }], error: null }
    const res = await get("owner_key=trevor")
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toHaveLength(1)
    expect(body[0].fmv).toBe(100)
    expect(body[0].low_ask).toBe(80)
    expect(body[0].discount_pct).toBe(20) // (100-80)/100
    expect(body[0].has_alert).toBe(true)
  })

  it("POST 201s and echoes the upserted row", async () => {
    state.single = { data: { id: "wl1", owner_key: "trevor", edition_key: "73:2785" }, error: null }
    const res = await post({ owner_key: "trevor", edition_key: "73:2785" })
    expect(res.status).toBe(201)
    expect((await res.json()).id).toBe("wl1")
  })
})
