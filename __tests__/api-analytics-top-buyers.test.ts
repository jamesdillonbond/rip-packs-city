import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/analytics/top-buyers.
//
// ⛔ THIS FILE USED TO PIN THE DEFECT AS THE CONTRACT — "No guards (unknown
// collection falls back to nba_top_shot)", asserted as
// `expect(body.collection).toBe("nba_top_shot") // unknown → fallback`.
// That fallback is the honesty defect, not a lenient default: a caller asking
// for one collection was handed ANOTHER's buyers, under a heading naming the
// one it asked for. INVERTED 2026-09-20 rather than deleted — a passing test
// asserting a promise is what holds that promise in place.
//
// Wraps get_top_accumulators, then
// enriches with an editions lookup (from().select().in()) and resolved
// usernames (@/lib/flowty-username, mocked). Pins the happy enriched path with
// a swept-edition join and the rpc-error 500.

const rpc: { data: any; error: any; throws?: boolean } = { data: null, error: null }
const editions: { data: any } = { data: [] }

vi.mock("@/lib/supabase", () => {
  const eb: any = { select: () => eb, in: async () => ({ data: editions.data }) }
  return {
    supabaseAdmin: {
      rpc: async () => {
        if (rpc.throws) throw new Error("connection reset")
        return { data: rpc.data, error: rpc.error }
      },
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

beforeEach(() => { rpc.data = null; rpc.error = null; rpc.throws = false; editions.data = [] })

describe("GET /api/analytics/top-buyers", () => {
  it("enriches rows with username and swept-edition display fields", async () => {
    rpc.data = [{ rank: 1, buyer_address: "0xbuyer", buy_count: 5, top_edition_id: "e1" }]
    editions.data = [{ id: "e1", player_name: "Lillard", set_name: "Base" }]
    // A REAL collection now, because the enrichment is this arm's subject and
    // an unrecognised slug no longer reaches the RPC at all (see the arm below).
    const res = await GET(req("https://t/api/analytics/top-buyers?collection=candy_mlb&days=30"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collection).toBe("candy_mlb")
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

  it("500s when the rpc throws (outer catch path)", async () => {
    rpc.throws = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("top_buyers_failed")
  })
})

// ── The collection you asked for is the one you get (2026-09-20) ───────────
describe("GET /api/analytics/top-buyers — an unsupported collection is refused, not substituted", () => {
  it("400s on an unrecognised slug instead of answering with Top Shot's buyers", async () => {
    rpc.data = [{ rank: 1, buyer_address: "0xbuyer", buy_count: 5, top_edition_id: null }]
    const res = await GET(req("https://t/api/analytics/top-buyers?collection=weird"))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toBe("unsupported_collection")
    // THE ASSERTION IS THE ABSENCE OF THE FALSE ANSWER: no rows, and no other
    // collection's name attached to them.
    expect(body.rows).toBeUndefined()
    expect(body.collection).toBeUndefined()
  })

  it("400s for disney_pinnacle, whose sales this RPC cannot see", async () => {
    // Pinnacle's sales live in `pinnacle_sales`, which get_top_accumulators does
    // not read. Returning [] would render as "no buyer-resolved accumulation"
    // about a collection with 240 distinct buyers in 30d.
    const res = await GET(req("https://t/api/analytics/top-buyers?collection=disney_pinnacle"))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe("unsupported_collection")
  })

  it("candy_mlb, laliga_golazos and ufc_strike are all served", async () => {
    rpc.data = []
    for (const c of ["candy_mlb", "laliga_golazos", "ufc_strike"]) {
      const res = await GET(req(`https://t/api/analytics/top-buyers?collection=${c}`))
      expect(res.status).toBe(200)
      expect((await res.json()).collection).toBe(c)
    }
  })

  it("an ABSENT param still defaults — a default is not a substitution", async () => {
    rpc.data = []
    const res = await GET(req("https://t/api/analytics/top-buyers"))
    expect(res.status).toBe(200)
    expect((await res.json()).collection).toBe("nba_top_shot")
  })
})
