import { describe, it, expect, vi, beforeEach } from "vitest"

// lib/candy/collections-market.ts — the market lane of the non-registry Candy collections.
// The properties that matter: a sale is OFFERED to the drain queue once, never re-offered;
// the high-water mark advances only behind a walk that reached it and whose every offer
// landed; ME's ambiguous zero (no floorPrice) is recorded as ambiguous; a collection with no
// ME symbol is stamped, not failed.

vi.mock("@/lib/chains/solana/das", () => ({ solUsd: async () => 150 }))
vi.mock("@/lib/chains/solana/normalize", () => ({ CANDY_MLB_UUID: "c1" }))

import { runCollectionsMarket, QUEUE_REASON } from "@/lib/candy/collections-market"

const NOW = Date.parse("2026-11-09T05:00:00Z")
const sec = (iso: string) => Date.parse(iso) / 1000

const state: {
  queue: any[]
  updates: Array<{ address: string; patch: any }>
  daily: any[]
  parks: any[]
  parkError: any
  queued: string[]
  sold: string[]
  me: Record<string, any>
  meCalls: string[]
} = { queue: [], updates: [], daily: [], parks: [], parkError: null, queued: [], sold: [], me: {}, meCalls: [] }

function db() {
  return {
    rpc: async (name: string, args: any) => {
      if (name === "candy_park_unresolved_sale") {
        if (state.parkError) return { data: null, error: state.parkError }
        state.parks.push(args)
      }
      return { data: null, error: null }
    },
    from: (table: string) => {
      const b: any = {
        _patch: null,
        select: () => b, neq: () => b, not: () => b, order: () => b,
        eq: (_c: string, v: any) => {
          if (b._patch) { state.updates.push({ address: v, patch: b._patch }); return Promise.resolve({ error: null }) }
          return b
        },
        limit: async () => {
          if (table === "candy_collections") return { data: state.queue, error: null }
          if (table === "editions") return { data: [{ external_id: "c:x:a" }], error: null }
          if (table === "wallet_moments_cache") return { data: [{ moment_id: "MINT1" }], error: null }
          return { data: [], error: null }
        },
        in: (_c: string, vals: string[]) => {
          if (table === "candy_sales_unresolved") return Promise.resolve({ data: vals.filter((v) => state.queued.includes(v)).map((signature) => ({ signature })), error: null })
          if (table === "sales") return Promise.resolve({ data: vals.filter((v) => state.sold.includes(v)).map((transaction_hash) => ({ transaction_hash })), error: null })
          return b
        },
        update: (patch: any) => { b._patch = patch; return b },
        upsert: async (row: any) => { state.daily.push(row); return { error: null } },
      }
      return b
    },
  }
}

const fetchImpl = async (url: string) => {
  const path = url.replace("https://api-mainnet.magiceden.dev/v2", "")
  state.meCalls.push(path)
  const key = Object.keys(state.me).find((k) => path.startsWith(k))
  const body = key ? state.me[key] : null
  if (body === undefined || body === null) return new Response("not found", { status: 404 })
  if (body instanceof Response) return body
  return new Response(JSON.stringify(typeof body === "function" ? body(path) : body), { status: 200 })
}

const col = (over: any = {}) => ({ address: "A", name: "2022 Leadoff ICONs", set_id: "s1", me_symbol: "2022_leadoff_icons", me_symbol_checked_at: null, sales_high_water_at: "2026-11-08T00:00:00Z", ...over })
const run = (budgetMs = 60_000, now = () => NOW) => runCollectionsMarket(db(), { budgetMs, now, fetchImpl: fetchImpl as any, pauseMs: 0 })

beforeEach(() => {
  state.queue = []; state.updates = []; state.daily = []; state.parks = []; state.parkError = null
  state.queued = []; state.sold = []; state.me = {}; state.meCalls = []
})

describe("runCollectionsMarket", () => {
  it("offers each NEW sale to the drain queue once and advances the high-water mark to the newest activity", async () => {
    state.queue = [col()]
    state.me["/collections/2022_leadoff_icons/stats"] = { floorPrice: 48614487, listedCount: 2, avgPrice24hr: 3900000 }
    state.me["/collections/2022_leadoff_icons/activities"] = [
      { type: "list", signature: "L1", tokenMint: "M0", blockTime: sec("2026-11-09T01:00:00Z") },
      { type: "buyNow", signature: "S1", tokenMint: "M1", blockTime: sec("2026-11-08T20:00:00Z"), price: 0.0039, buyer: "B", seller: "Z" },
      { type: "buyNow", signature: "S2", tokenMint: "M2", blockTime: sec("2026-11-08T12:00:00Z"), price: 0.01 },
      { type: "buyNow", signature: "S3", tokenMint: "M3", blockTime: sec("2026-11-08T06:00:00Z"), price: 0.02 },
      { type: "buyNow", signature: "OLD", tokenMint: "M4", blockTime: sec("2026-11-07T23:00:00Z"), price: 0.03 },
    ]
    state.queued = ["S2"] // already queued
    state.sold = ["S3"] // already in sales
    const r = await run()
    expect(r.ok).toBe(true)
    expect(state.parks.map((p) => p.p_signature)).toEqual(["S1"])
    expect(state.parks[0]).toMatchObject({ p_token_mint: "M1", p_price_sol: 0.0039, p_skip_reason: QUEUE_REASON })
    const patch = state.updates.at(-1)!.patch
    expect(patch.sales_high_water_at).toBe("2026-11-09T01:00:00.000Z")
    expect(state.daily[0]).toMatchObject({ address: "A", day: "2026-11-09", floor_sol: 0.048614487, listed_count: 2, stats_has_floor: true, sol_usd: 150 })
  })

  it("records ME's floorless zero as AMBIGUOUS, never as a confirmed empty market", async () => {
    state.queue = [col()]
    state.me["/collections/2022_leadoff_icons/stats"] = { symbol: "2022_leadoff_icons", listedCount: 0 }
    state.me["/collections/2022_leadoff_icons/activities"] = []
    await run()
    expect(state.daily[0]).toMatchObject({ listed_count: 0, floor_sol: null, stats_has_floor: false })
  })

  it("a failed offer fails the run and advances NO high-water mark (the walk is re-read next run)", async () => {
    state.queue = [col()]
    state.me["/collections/2022_leadoff_icons/stats"] = { floorPrice: 1, listedCount: 1 }
    state.me["/collections/2022_leadoff_icons/activities"] = [{ type: "buyNow", signature: "S1", tokenMint: "M1", blockTime: sec("2026-11-08T20:00:00Z"), price: 1 }]
    state.parkError = { message: "deadlock detected" }
    const r = await run()
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/deadlock/)
    const patch = state.updates.at(-1)!.patch
    expect(patch.sales_high_water_at).toBeUndefined()
    expect(patch.market_error).toMatch(/deadlock/)
  })

  it("a walk stopped by the time budget advances no high-water mark", async () => {
    state.queue = [col()]
    state.me["/collections/2022_leadoff_icons/stats"] = { floorPrice: 1, listedCount: 1 }
    state.me["/collections/2022_leadoff_icons/activities"] = Array.from({ length: 500 }, (_, i) => ({ type: "list", signature: `L${i}`, blockTime: sec("2026-11-09T01:00:00Z") - i }))
    let t = NOW
    const r = await runCollectionsMarket(db(), { budgetMs: 1000, now: () => (t += 400), fetchImpl: fetchImpl as any, pauseMs: 0 })
    expect(r.collections[0].high_water_advanced).toBe(false)
    expect(state.updates.at(-1)!.patch.sales_high_water_at).toBeUndefined()
  })

  it("finds a missing symbol from ME's own token record for a card the census holds", async () => {
    state.queue = [col({ me_symbol: null, sales_high_water_at: null })]
    state.me["/tokens/MINT1"] = { collection: "2022_play_of_the_day" }
    state.me["/collections/2022_play_of_the_day/stats"] = { floorPrice: 39292731, listedCount: 94 }
    state.me["/collections/2022_play_of_the_day/activities"] = []
    const r = await run()
    expect(r.symbols_found).toBe(1)
    expect(state.updates.at(-1)!.patch).toMatchObject({ me_symbol: "2022_play_of_the_day" })
    expect(state.daily[0].listed_count).toBe(94)
  })

  it("a collection ME does not know is stamped (no symbol) — not an error — and not re-asked inside a week", async () => {
    state.queue = [col({ me_symbol: null })]
    const r = await run()
    expect(r.ok).toBe(true)
    expect(r.without_symbol).toBe(1)
    expect(typeof state.updates.at(-1)!.patch.me_symbol_checked_at).toBe("string")
    expect(state.updates.at(-1)!.patch.me_symbol).toBeUndefined()

    state.updates = []; state.meCalls = []
    state.queue = [col({ me_symbol: null, me_symbol_checked_at: new Date(NOW - 86_400_000).toISOString() })]
    await run()
    expect(state.meCalls).toEqual([])
  })

  it("a first walk looks back 30 days, not to the start of the feed", async () => {
    state.queue = [col({ sales_high_water_at: null })]
    state.me["/collections/2022_leadoff_icons/stats"] = { floorPrice: 1, listedCount: 1 }
    state.me["/collections/2022_leadoff_icons/activities"] = [
      { type: "buyNow", signature: "RECENT", tokenMint: "M1", blockTime: sec("2026-10-20T00:00:00Z"), price: 1 },
      { type: "buyNow", signature: "ANCIENT", tokenMint: "M2", blockTime: sec("2026-09-01T00:00:00Z"), price: 1 },
    ]
    await run()
    expect(state.parks.map((p) => p.p_signature)).toEqual(["RECENT"])
  })
})
