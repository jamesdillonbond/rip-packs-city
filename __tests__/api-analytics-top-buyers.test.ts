import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/top-buyers. No guards (unknown
// collection falls back to nba_top_shot). Wraps get_top_accumulators, then
// enriches with an editions lookup (from().select().in()) and resolved
// usernames (@/lib/flowty-username, mocked). Pins the happy enriched path with
// a swept-edition join and the rpc-error 500.

const rpc: { data: any; error: any } = { data: null, error: null }
const editions: { data: any } = { data: [] }

vi.mock("@/lib/supabase", () => {
  const eb: any = { select: () => eb, in: async () => ({ data: editions.data }) }
  return {
    supabaseAdmin: {
      rpc: async () => ({ data: rpc.data, error: rpc.error }),
      from: () => eb,
    },
  }
})
vi.mock("@/lib/flowty-username", () => ({
  resolveUsernames: async () => new Map<string, string>([["0xbuyer", "bob"]]),
  displayName: (addr: string, names: Map<string, string>) => names.get(addr) ?? addr,
}))

import { GET } from "@/app/api/analytics/top-buyers/route"

const req = (url = "https://t/api/analytics/top-buyers") => ({ url }) as any

beforeEach(() => { rpc.data = null; rpc.error = null; editions.data = [] })

describe("GET /api/analytics/top-buyers", () => {
  it("enriches rows with username and swept-edition display fields", async () => {
    rpc.data = [{ rank: 1, buyer_address: "0xbuyer", buy_count: 5, top_edition_id: "e1" }]
    editions.data = [{ id: "e1", player_name: "Lillard", set_name: "Base" }]
    const res = await GET(req("https://t/api/analytics/top-buyers?collection=weird&days=30"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("nba_top_shot") // unknown → fallback
    expect(body.days).toBe(30)
    expect(body.rows[0].username).toBe("bob")
    expect(body.rows[0].top_edition_player).toBe("Lillard")
    expect(body.rows[0].top_edition_set).toBe("Base")
  })

  it("500s on an rpc error", async () => {
    rpc.error = { message: "db" }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("top_buyers_failed")
  })
})
