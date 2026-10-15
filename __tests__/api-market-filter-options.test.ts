import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/market/filter-options — the Market dropdowns' full option lists
// (get_market_filter_options over editions). Pins: an unknown collection is
// REFUSED; a collection whose market filters do not run against editions gets
// `catalog: false`, never a list that could match nothing; a failed or malformed
// read is an error, not empty lists.

const rpc: { data: any; error: any; args: any } = { data: null, error: null, args: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_fn: string, args: any) => { rpc.args = args; return { data: rpc.data, error: rpc.error } } },
}))

import { GET } from "@/app/api/market/filter-options/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any
const url = (id: string) => `https://t/api/market/filter-options?collectionId=${id}`

beforeEach(() => { rpc.data = { sets: [], series: [], teams: [], players: [] }; rpc.error = null; rpc.args = null })

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

  it("returns every set, series, team and player for Top Shot", async () => {
    rpc.data = { sets: ["Metallic Gold LE"], series: ["0", "8"], teams: ["Portland Fire", ""], players: ["Paige Bueckers"] }
    const res = await GET(req(url(TS)))
    expect(res.status).toBe(200)
    expect(rpc.args).toEqual({ p_collection_id: TS })
    expect(await res.json()).toEqual({ catalog: true, sets: ["Metallic Gold LE"], series: ["0", "8"], teams: ["Portland Fire"], players: ["Paige Bueckers"] })
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
