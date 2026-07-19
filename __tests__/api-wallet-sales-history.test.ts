import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for GET /api/wallet-sales-history. Two pre-DB 400 guards
// fire before wallet resolution: missing wallet, and an unknown collection slug.
// Success path: a raw 0x address + a known collection reads `sales` joined to
// `editions` — a self-referential chainable resolves one fixture sale which is
// mapped and side-attributed (seller == wallet → "sell").

const state: { rows: any } = { rows: { data: [], error: null } }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b, eq: () => b, or: () => b, order: () => b, limit: () => b,
    then: (resolve: any) => resolve(state.rows),
  }
  return { supabaseAdmin: { from: () => b } }
})
vi.mock("@/lib/chains/flow/topshot", () => ({ topshotGraphql: async () => ({}) }))

import { GET } from "@/app/api/wallet-sales-history/route"

const req = (u: string) => ({ nextUrl: new URL(u) }) as any

beforeEach(() => { state.rows = { data: [], error: null } })

describe("GET /api/wallet-sales-history — pre-DB guards", () => {
  it("400s without a wallet", async () => {
    expect((await GET(req("https://t/api/wallet-sales-history"))).status).toBe(400)
  })
  it("400s on an unknown collection", async () => {
    const res = await GET(req("https://t/api/wallet-sales-history?wallet=0xabc&collection=not-real"))
    expect(res.status).toBe(400)
  })
})

describe("GET /api/wallet-sales-history — success path", () => {
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
})
