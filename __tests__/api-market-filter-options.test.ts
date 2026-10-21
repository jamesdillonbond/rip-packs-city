import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/market/filter-options — the Market dropdowns' full option lists
// (get_market_filter_options over editions). Pins: an unknown collection is
// REFUSED; a collection whose market filters do not run against editions gets
// `catalog: false`, never a list that could match nothing; a failed or malformed
// read is an error, not empty lists.

const rpc: { data: any; error: any; args: any; badges: any; badgesError: any } = { data: null, error: null, args: null, badges: [], badgesError: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      rpc.args = args
      return fn === "get_market_badge_options" ? { data: rpc.badges, error: rpc.badgesError } : { data: rpc.data, error: rpc.error }
    },
  },
}))

import { GET } from "@/app/api/market/filter-options/route"
import { DB_FILTERED_MARKET_COLLECTION_IDS } from "@/lib/market/edition-market-arms"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any
const url = (id: string) => `https://t/api/market/filter-options?collectionId=${id}`

beforeEach(() => { rpc.data = { sets: [], series: [], teams: [], players: [] }; rpc.error = null; rpc.args = null; rpc.badges = []; rpc.badgesError = null })

describe("GET /api/market/filter-options", () => {
  it("refuses a missing or unknown collectionId without reading", async () => {
    expect((await GET(req("https://t/api/market/filter-options"))).status).toBe(400)
    expect((await GET(req(url("00000000-0000-0000-0000-000000000000")))).status).toBe(400)
    expect(rpc.args).toBeNull()
  })

  it("serves no catalog for a collection whose market does not filter on editions", async () => {
    const res = await GET(req(url(PINNACLE)))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ catalog: false })
    expect(rpc.args).toBeNull()
  })

  // 2026-10-18: Golazos' get_golazos_market_editions_v2 filters against editions
  // like the v3 RPCs; a hand list left it on the 50-row facets.
  it("serves the catalog for EVERY DB-filtered arm, Golazos included", async () => {
    for (const id of DB_FILTERED_MARKET_COLLECTION_IDS) {
      rpc.args = null
      const res = await GET(req(url(id)))
      expect((await res.json()).catalog, id).toBe(true)
      expect(rpc.args).toEqual({ p_collection_id: id })
    }
    expect(DB_FILTERED_MARKET_COLLECTION_IDS.has("06248cc4-b85f-47cd-af67-1855d14acd75")).toBe(true)
  })

  it("returns every set, series, team, player and badge for Top Shot", async () => {
    rpc.data = { sets: ["Metallic Gold LE"], series: ["0", "8"], teams: ["Portland Fire", ""], players: ["Paige Bueckers"] }
    rpc.badges = ["Rookie Year", "Top Shot Debut"]
    const res = await GET(req(url(TS)))
    expect(res.status).toBe(200)
    expect(rpc.args).toEqual({ p_collection_id: TS })
    expect(await res.json()).toEqual({ catalog: true, sets: ["Metallic Gold LE"], series: ["0", "8"], teams: ["Portland Fire"], players: ["Paige Bueckers"], badges: ["Rookie Year", "Top Shot Debut"] })
  })

  it("answers a failed BADGE read as an error, not a catalog with no badges", async () => {
    rpc.badgesError = { message: "db" }
    const res = await GET(req(url(TS)))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).badges).toBeUndefined()
  })

  it("answers a failed read as an error, not empty lists", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req(url(TS)))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).teams).toBeUndefined()
  })

  it("answers a malformed payload as an error", async () => {
    rpc.data = { sets: [], teams: [] }
    expect((await GET(req(url(TS)))).status).toBeGreaterThanOrEqual(500)
  })
})
