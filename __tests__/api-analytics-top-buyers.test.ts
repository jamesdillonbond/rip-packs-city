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

const rpc: { data: any; error: any; throws?: boolean; calls: string[] } = { data: null, error: null, calls: [] }
const editions: { data: any } = { data: [] }

vi.mock("@/lib/supabase", () => {
  const eb: any = { select: () => eb, in: async () => ({ data: editions.data }) }
  return {
    supabaseAdmin: {
      rpc: async (fn: string) => {
        rpc.calls.push(fn)
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

  // RE-PINNED 2026-10-26 (premise changed): this used to 400 disney_pinnacle because
  // get_top_accumulators cannot see pinnacle_sales. It now has its OWN arm,
  // get_pinnacle_top_accumulators — the property kept is that Pinnacle is NEVER asked of the
  // shared RPC (which would answer [] = "no accumulation" about a collection with real buyers).
  it("serves disney_pinnacle from its own arm, never from get_top_accumulators", async () => {
    rpc.data = []
    rpc.calls = []
    const res = await GET(req("https://t/api/analytics/top-buyers?collection=disney_pinnacle"))
    expect(res.status).toBe(200)
    expect((await res.json()).collection).toBe("disney_pinnacle")
    expect(rpc.calls).toEqual(["get_pinnacle_top_accumulators"])
  })

  it("names a Pinnacle buyer's swept pin from the catalog by render_id", async () => {
    rpc.data = [{ rank: 1, buyer_address: "0xbuyer", buy_count: 16, spend_usd: 40, avg_price_usd: 2.5, distinct_editions: 1, top_edition_id: "OEV2-ALIN-CRIM-S4", top_edition_buys: 16 }]
    editions.data = [{ render_id: "OEV2-ALIN-CRIM-S4", character_name: "Crimson ", set_name: "Alien Vol.1" }]
    const body = await (await GET(req("https://t/api/analytics/top-buyers?collection=disney_pinnacle"))).json()
    expect(body.rows[0]).toMatchObject({ username: "bob", top_edition_player: "Crimson", top_edition_set: "Alien Vol.1" })
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
