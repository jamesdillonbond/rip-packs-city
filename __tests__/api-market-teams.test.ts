import { describe, it, expect, beforeEach, vi } from "vitest"

// GET /api/market/teams — the Market Team dropdown's full option list
// (get_market_team_options over editions.team_name). Pins: an unknown collection
// is REFUSED, never answered with another collection's teams; the RPC is called
// with the requested collection; a failed read is an error, not an empty list.

const rpc: { data: any; error: any; args: any } = { data: [], error: null, args: null }
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: { rpc: async (_fn: string, args: any) => { rpc.args = args; return { data: rpc.data, error: rpc.error } } },
}))

import { GET } from "@/app/api/market/teams/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { rpc.data = []; rpc.error = null; rpc.args = null })

describe("GET /api/market/teams", () => {
  it("refuses a missing or unknown collectionId without reading", async () => {
    expect((await GET(req("https://t/api/market/teams"))).status).toBe(400)
    const res = await GET(req("https://t/api/market/teams?collectionId=00000000-0000-0000-0000-000000000000"))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).not.toContain("Portland")
    expect(rpc.args).toBeNull()
  })

  it("returns every team the collection's editions carry, including ones with nothing on page 1", async () => {
    rpc.data = [{ team_name: "Portland Fire" }, { team_name: "Portland Trail Blazers" }, { team_name: null }]
    const res = await GET(req(`https://t/api/market/teams?collectionId=${TS}`))
    expect(res.status).toBe(200)
    expect(rpc.args).toEqual({ p_collection_id: TS })
    expect((await res.json()).teams).toEqual(["Portland Fire", "Portland Trail Blazers"])
  })

  it("answers a failed read as an error, not an empty team list", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req(`https://t/api/market/teams?collectionId=${TS}`))
    expect(res.status).toBeGreaterThanOrEqual(500)
    expect((await res.json()).teams).toBeUndefined()
  })
})
