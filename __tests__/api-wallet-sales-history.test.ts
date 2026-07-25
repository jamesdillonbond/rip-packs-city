import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet-sales-history. Two pre-DB 400 guards
// fire before wallet resolution: missing wallet, and an unknown collection slug.
// Deep legs added: the Pinnacle branch (pinnacle_sales → pinnacle_editions, text
// IDs), username resolution via topshotGraphql (hit + unresolved-throw → 500),
// limit clamping, buy-side attribution, the TopShot "only sells" note, the
// editions-as-array shape, and both the sales-error and pinnacle-error 500s.

const state: { rows: any; gql: any } = { rows: { data: [], error: null }, gql: {} }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, or: () => b, order: () => b, limit: () => b,
    then: (resolve: any) => resolve(state.rows),
  }
  return { supabaseAdmin: { from: () => b } }
})
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => state.gql }))

import { GET } from "@/app/api/wallet-sales-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => {
  state.rows = { data: [], error: null }
  state.gql = {}
})

describe("GET /api/wallet-sales-history — pre-DB guards", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/wallet-sales-history"))).status).toBe(400)
  })
  it("400s on an unknown collection", async () => {
    const res = await GET(req("https://t/api/wallet-sales-history?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
})

describe("GET /api/wallet-sales-history — sales (uuid) path", () => {
  it("200s and maps a sale row (seller == wallet → sell)", async () => {
    state.rows = {
      data: [
        {
          price_usd: 42,
          sold_at: "2026-07-01T00:00:00Z",
          marketplace: "flowty",
          serial_number: 5,
          buyer_address: "0x0000000000000000",
          seller_address: "0xbd94cade097e50ac",
          editions: { player_name: "Ja Morant", set_name: "Base Set", tier: "COMMON" },
        },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallet).toBe("0xbd94cade097e50ac")
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].price_usd).toBe(42)
    expect(body.rows[0].player_name).toBe("Ja Morant")
    expect(body.rows[0].side).toBe("sell")
  })

  it("attributes a buy when buyer == wallet, and tolerates editions-as-array", async () => {
    state.rows = {
      data: [
        {
          price_usd: 10,
          sold_at: "2026-07-02T00:00:00Z",
          marketplace: null,
          serial_number: null,
          buyer_address: "0xBD94CADE097E50AC", // upper-cased → still matches (lowercased compare)
          seller_address: "0x1111111111111111",
          editions: [{ player_name: "Anthony Edwards", set_name: "S4", tier: "RARE" }],
        },
      ],
      error: null,
    }
    // laliga-golazos → not TopShot, so no note even though a single sell/buy
    const body = await (await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=laliga-golazos"))).json()
    expect(body.rows[0].side).toBe("buy")
    expect(body.rows[0].player_name).toBe("Anthony Edwards")
    expect(body.note).toBeUndefined()
  })

  it("adds the TopShot 'only sells' note when every row is a sell", async () => {
    state.rows = {
      data: [
        { price_usd: 5, sold_at: "2026-07-03T00:00:00Z", marketplace: "flowty", serial_number: 1, buyer_address: "0x2222222222222222", seller_address: "0xbd94cade097e50ac", editions: null },
      ],
      error: null,
    }
    const body = await (await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=nba-top-shot"))).json()
    expect(body.note).toMatch(/Buy-side wallet identities/)
    expect(body.rows[0].player_name).toBeNull() // null edition tolerated
  })

  it("clamps an out-of-range limit and still returns 200", async () => {
    const body = await (await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=nba-top-shot&limit=9999"))).json()
    expect(Array.isArray(body.rows)).toBe(true)
  })

  it("sales error → 500", async () => {
    state.rows = { data: null, error: { message: "sales down" } }
    expect((await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=nba-top-shot"))).status).toBe(500)
  })
})

describe("GET /api/wallet-sales-history — Pinnacle (text id) path", () => {
  it("maps a pinnacle_sales row through the joined edition", async () => {
    state.rows = {
      data: [
        {
          sale_price_usd: 88,
          sold_at: "2026-07-04T00:00:00Z",
          source: "pinnacle-direct",
          serial_number: 12,
          buyer_address: "0xbd94cade097e50ac",
          seller_address: "0x3333333333333333",
          pinnacle_editions: { character_name: "Mickey", set_name: "Origins", edition_type: "Chaser" },
        },
      ],
      error: null,
    }
    const body = await (await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=disney-pinnacle"))).json()
    expect(body.rows[0].player_name).toBe("Mickey")
    expect(body.rows[0].tier).toBe("Chaser")
    expect(body.rows[0].price_usd).toBe(88)
    expect(body.rows[0].side).toBe("buy")
    expect(body.note).toBeUndefined() // Pinnacle never gets the TopShot note
  })

  it("pinnacle error → 500", async () => {
    state.rows = { data: null, error: { message: "pinnacle down" } }
    expect((await GET(req("https://t/api/wallet-sales-history?wallet=0xbd94cade097e50ac&collection=disney-pinnacle"))).status).toBe(500)
  })
})

describe("GET /api/wallet-sales-history — username resolution", () => {
  it("resolves a @username to its flowAddress via topshotGraphql", async () => {
    state.gql = { getUserProfileByUsername: { publicInfo: { flowAddress: "bd94cade097e50ac" } } } // no 0x → route prefixes
    state.rows = { data: [], error: null }
    const body = await (await GET(req("https://t/api/wallet-sales-history?wallet=@trevor&collection=nba-top-shot"))).json()
    expect(body.wallet).toBe("0xbd94cade097e50ac")
  })

  it("500s when the username cannot be resolved", async () => {
    state.gql = { getUserProfileByUsername: { publicInfo: { flowAddress: null } } }
    const res = await GET(req("https://t/api/wallet-sales-history?wallet=nobody&collection=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/resolve/i)
  })
})
