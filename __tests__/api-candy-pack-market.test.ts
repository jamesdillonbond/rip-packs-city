import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * GET /api/candy-pack-market — Candy MLB Packs tab backend.
 *
 * Stated as the ABSENCE of false claims: an unconfirmed ask must never be the
 * headline floor (the 2026-09-25 floor was a July listing whose token had sold),
 * a failed secondary read must not read as "none", a failed market rollup must
 * not render a zeroed board, and a Flow wallet must not be answered "0 packs".
 */

type Res = { data: unknown; error: unknown; count?: number | null }
const state: Record<string, Res> = {}
const ownedFilters: Array<[string, unknown]> = []

vi.mock("@/lib/supabase", () => {
  function builder(table: string) {
    let usedIn = false
    let bySeller = false
    let byOwner = false
    const b: any = {
      select: () => b,
      eq: (c: string, v: unknown) => {
        if (table === "candy_packs") {
          ownedFilters.push([c, v])
          if (c === "owner") byOwner = true
        }
        if (table === "candy_pack_listings" && c === "seller") bySeller = true
        return b
      },
      in: () => ((usedIn = true), b),
      not: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve: any) => {
        const key =
          table === "candy_packs" && byOwner ? "candy_packs:owned"
          : table === "candy_packs" && usedIn ? "candy_packs:holders"
          : table === "candy_pack_listings" && bySeller ? "candy_pack_listings:listed"
          : table
        return resolve(state[key] ?? { data: [], error: null })
      },
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})

import { GET, CANDY_PACK_ASK_CONFIRMED_HOURS } from "@/app/api/candy-pack-market/route"

const req = (qs = "") => ({ nextUrl: new URL("https://t/api/candy-pack-market" + qs) }) as any
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString()
const STALE = new Date(Date.now() - (CANDY_PACK_ASK_CONFIRMED_HOURS + 48) * 3_600_000).toISOString()
const WALLET = "7xPaEpQwzGmdTxj4kF3yUq2n8HcVbRsLtNaWoPe9ZkD1"
const TREASURY = "BhA2Bfd8t2F2jDiUNdioGRJQt7MiaWo3Ro5H2Yt7APe2"
const ESCROW = "1BWutmTvYPwDtmw9abTkS4Ssr8no61spGAvW1X6NDix"

const MARKET = {
  pack_assets_indexed: 2501, declared_supply: 2500, duplicate_serials: 1, treasury_held: 2336,
  collector_held: 165, collector_wallets: 63, burnt_assets: 0, inventory_refreshed_at: FRESH,
  active_asks: 23, floor_ask_usd: 30.02, floor_ask_sol: 0.25, sales_all: 465, sales_24h: 0, sales_7d: 0,
  volume_7d_usd: null, avg_7d_usd: null, median_7d_usd: null, last_sale_at: "2026-09-14T19:52:44Z",
  last_sale_usd: 51.78, retail_usd: 10, typical_pull_ev_usd: 11.6, actual_ev_usd: 44.83,
}

beforeEach(() => {
  for (const k of Object.keys(state)) delete state[k]
  ownedFilters.length = 0
  state.candy_pack_market = { data: [MARKET], error: null }
  state.candy_pack_ev_model = { data: [{ icon_slots: 10, rainbow_chance: 0.15, pack_cost_usd: 10, typical_pull_ev_usd: 11.6, actual_ev_usd: 44.83 }], error: null }
  state.candy_pack_listings = {
    data: [
      { token_mint: "a", price_usd: 30.02, price_sol: 0.25, last_seen_at: STALE, expiry: null },
      { token_mint: "b", price_usd: 36.44, price_sol: 0.3, last_seen_at: FRESH, expiry: null },
      { token_mint: "c", price_usd: 40, price_sol: 0.33, last_seen_at: FRESH, expiry: null },
    ],
    error: null,
  }
  state.candy_pack_sales = { data: [{ serial_number: 606, price_usd: 51.78, sold_at: "2026-09-14T19:52:44Z" }], error: null }
  state.candy_packs = { data: [{ image_url: "https://arweave.net/x" }], error: null }
  state.candy_treasury_wallet = { data: [{ wallet_address: TREASURY }], error: null }
})

async function body(qs = "") {
  const res = await GET(req(qs))
  return { status: res.status, json: await res.json() }
}

describe("GET /api/candy-pack-market", () => {
  it("the headline floor is the CONFIRMED floor — a stale cheaper ask never leads", async () => {
    const { json } = await body()
    expect(json.market.confirmedFloorUsd).toBe(36.44)
    expect(json.market.confirmedFloorUsd).not.toBe(MARKET.floor_ask_usd)
    expect(json.market.confirmedAsks).toBe(2)
    expect(json.market.unconfirmedAsks).toBe(1)
    // …and the unconfirmed ask is listed LAST, labelled.
    expect(json.asks.at(-1)).toMatchObject({ priceUsd: 30.02, confirmed: false })
    expect(json.asks[0]).toMatchObject({ priceUsd: 36.44, confirmed: true })
  })

  // 2026-09-25: Magic Eden kept returning launch-week asks on packs that are back
  // in Candy's treasury — one "confirmed" at $36.27 headlined the tile while the
  // real (escrowed) floor was $76.17.
  it("an ask on a pack the TREASURY holds is a ghost: never the floor, never counted", async () => {
    state["candy_packs:holders"] = {
      data: [
        { token_mint: "b", owner: TREASURY, is_burnt: false, serial_number: 5 },
        { token_mint: "c", owner: ESCROW, is_burnt: false, serial_number: 6 },
      ],
      error: null,
    }
    const { json } = await body()
    expect(json.market.confirmedFloorUsd).toBe(40)
    expect(json.market.confirmedAsks).toBe(1)
    expect(json.market.staleAsks).toBe(1)
    expect(json.asks.map((a: any) => a.priceUsd)).not.toContain(36.44)
  })

  it("an ask on a BURNT pack is excluded too", async () => {
    state["candy_packs:holders"] = { data: [{ token_mint: "b", owner: ESCROW, is_burnt: true, serial_number: 5 }], error: null }
    const { json } = await body()
    expect(json.market.confirmedFloorUsd).toBe(40)
    expect(json.market.staleAsks).toBe(1)
  })

  it("if the holder check cannot run, the asks panel says it failed — never unverified asks", async () => {
    state["candy_packs:holders"] = { data: null, error: { message: "boom" } }
    const { json } = await body()
    expect(json.asks).toBeNull()
    expect(json.asks_error).toBe(true)
    expect(json.market.confirmedFloorUsd).toBeNull()
    expect(json.market.confirmedAsks).toBeNull()
  })

  it("an unknown treasury wallet fails the holder check closed", async () => {
    state.candy_treasury_wallet = { data: [], error: null }
    const { json } = await body()
    expect(json.asks_error).toBe(true)
    expect(json.market.confirmedFloorUsd).toBeNull()
  })

  it("no confirmed ask → no floor, not the stale one", async () => {
    state.candy_pack_listings = { data: [{ token_mint: "a", price_usd: 30.02, price_sol: 0.25, last_seen_at: STALE, expiry: null }], error: null }
    const { json } = await body()
    expect(json.market.confirmedFloorUsd).toBeNull()
    expect(json.market.confirmedAsks).toBe(0)
  })

  it("a failed asks read is flagged, never 'no asks'", async () => {
    state.candy_pack_listings = { data: null, error: { message: "boom" } }
    const { status, json } = await body()
    expect(status).toBe(200)
    expect(json.asks).toBeNull()
    expect(json.asks_error).toBe(true)
    expect(json.market.confirmedAsks).toBeNull()
  })

  it("a failed sales read is flagged, never an empty list", async () => {
    state.candy_pack_sales = { data: null, error: { message: "boom" } }
    const { json } = await body()
    expect(json.sales).toBeNull()
    expect(json.sales_error).toBe(true)
  })

  it("a failed market rollup is an error, never a zeroed board", async () => {
    state.candy_pack_market = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const { status, json } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
    expect(json.market).toBeUndefined()
    expect(JSON.stringify(json)).not.toMatch(/canceling statement/)
  })

  it("an empty market rollup (no row) is also an error — the aggregate always has a row", async () => {
    state.candy_pack_market = { data: [], error: null }
    const { status } = await body()
    expect(status).toBeGreaterThanOrEqual(500)
  })

  it("reads a Solana wallet's packs with the key VERBATIM", async () => {
    state["candy_packs:owned"] = { data: [{ serial_number: 12 }, { serial_number: 99 }], error: null, count: 2 }
    const { json } = await body("?wallet=" + WALLET)
    expect(ownedFilters.find(([c]) => c === "owner")?.[1]).toBe(WALLET)
    expect(json.owned).toMatchObject({ count: 2, serials: [12, 99] })
  })

  it("a pack the wallet has LISTED (held in escrow) is still its sealed pack", async () => {
    state["candy_packs:owned"] = { data: [{ serial_number: 99 }], error: null, count: 1 }
    state["candy_pack_listings:listed"] = { data: [{ token_mint: "m1", expiry: null }, { token_mint: "m2", expiry: null }], error: null }
    state["candy_packs:holders"] = {
      data: [
        { token_mint: "m1", owner: ESCROW, is_burnt: false, serial_number: 12 },
        // A stale listing on a pack now back in the treasury is NOT the wallet's.
        { token_mint: "m2", owner: TREASURY, is_burnt: false, serial_number: 40 },
      ],
      error: null,
    }
    const { json } = await body("?wallet=" + WALLET)
    expect(json.owned).toMatchObject({ count: 2, listed: 1, serials: [12, 99] })
  })

  it("a failed listed-packs read fails the panel, never an undercount", async () => {
    state["candy_packs:owned"] = { data: [{ serial_number: 99 }], error: null, count: 1 }
    state["candy_pack_listings:listed"] = { data: null, error: { message: "boom" } }
    const { json } = await body("?wallet=" + WALLET)
    expect(json.owned).toBeNull()
    expect(json.owned_error).toMatch(/Could not read/)
  })

  it("a Flow wallet is refused for the packs panel, never '0 packs'", async () => {
    const { json } = await body("?wallet=0x1234567890abcdef")
    expect(json.owned).toBeNull()
    expect(json.owned_error).toMatch(/Solana/)
    expect(ownedFilters.some(([c]) => c === "owner")).toBe(false)
  })

  it("a failed owned read says so, never '0 packs'", async () => {
    state["candy_packs:owned"] = { data: null, error: { message: "boom" }, count: null }
    const { json } = await body("?wallet=" + WALLET)
    expect(json.owned).toBeNull()
    expect(json.owned_error).toBeTruthy()
  })
})
