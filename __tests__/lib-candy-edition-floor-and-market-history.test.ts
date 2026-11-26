// lib/candy/edition-floor-listing.ts + lib/candy/edition-market-history.ts had
// no test of their own (0–6 % statement coverage, 2026-11-26). Both are
// three-state reads: a FAILED read must come back ok:false (the edition page
// renders "could not be read"), never as "no listing" / "no history"; a
// genuinely empty read is ok:true with nothing in it.

import { describe, it, expect, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { fetchCandyFloorListing, CANDY_LISTING_CONFIRMED_HOURS } from "@/lib/candy/edition-floor-listing"
import { fetchCandyMarketHistory, fetchCandyScarcityRow } from "@/lib/candy/edition-market-history"

type Result = { data: unknown; error: unknown }

/** A chainable PostgREST-ish builder that records its calls and resolves to `result`. */
function builder(result: Result | (() => never)) {
  const calls: Array<[string, unknown[]]> = []
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "gt", "gte", "or", "order", "limit"]) {
    b[m] = (...args: unknown[]) => {
      calls.push([m, args])
      return b
    }
  }
  b.then = (res: (v: Result) => unknown, rej: (e: unknown) => unknown) => {
    try {
      const v = typeof result === "function" ? result() : result
      return Promise.resolve(v).then(res, rej)
    } catch (e) {
      return Promise.reject(e).then(res, rej)
    }
  }
  return { b, calls }
}

function dbFrom(result: Result | (() => never)) {
  const { b, calls } = builder(result)
  const tables: string[] = []
  return {
    db: { from: (t: string) => { tables.push(t); return b } },
    calls,
    tables,
  }
}

function dbRpc(result: Result | (() => never)) {
  const rpcCalls: Array<[string, unknown]> = []
  return {
    db: {
      rpc: (fn: string, args: unknown) => {
        rpcCalls.push([fn, args])
        return builder(result).b
      },
    },
    rpcCalls,
  }
}

describe("fetchCandyFloorListing", () => {
  it("returns the cheapest confirmed Magic Eden listing with its deep link", async () => {
    const { db, calls, tables } = dbFrom({ data: [{ token_mint: "MintAbc123", price_usd: "4.5" }], error: null })
    const r = await fetchCandyFloorListing("ed-1", db)
    expect(r.ok).toBe(true)
    expect(r.listing).toEqual({ mint: "MintAbc123", priceUsd: 4.5, url: "https://magiceden.io/item-details/MintAbc123" })
    expect(tables).toEqual(["candy_listings"])
    // Scoped to this edition, Magic Eden only, live rows only, cheapest first.
    expect(calls).toContainEqual(["eq", ["edition_id", "ed-1"]])
    expect(calls).toContainEqual(["eq", ["venue", "magic_eden"]])
    expect(calls).toContainEqual(["eq", ["is_active", true]])
    expect(calls).toContainEqual(["order", ["price_usd", { ascending: true }]])
    const gte = calls.find(([m]) => m === "gte")
    expect(gte?.[1][0]).toBe("last_seen_at")
    const ageH = (Date.now() - Date.parse(String(gte?.[1][1]))) / 3600_000
    expect(ageH).toBeGreaterThan(CANDY_LISTING_CONFIRMED_HOURS - 0.1)
    expect(ageH).toBeLessThan(CANDY_LISTING_CONFIRMED_HOURS + 0.1)
  })

  it("an empty read is ok:true with no listing (the CTA hides, honestly)", async () => {
    const r = await fetchCandyFloorListing("ed-1", dbFrom({ data: [], error: null }).db)
    expect(r).toEqual({ listing: null, ok: true })
  })

  it("a row without a mint or a usable price is not linked", async () => {
    for (const row of [
      { token_mint: null, price_usd: 3 },
      { token_mint: "M", price_usd: "abc" },
      { token_mint: "M", price_usd: 0 },
    ]) {
      const r = await fetchCandyFloorListing("ed-1", dbFrom({ data: [row], error: null }).db)
      expect(r).toEqual({ listing: null, ok: true })
    }
  })

  it("a FAILED read is ok:false, never 'no listing'", async () => {
    const r = await fetchCandyFloorListing("ed-1", dbFrom({ data: null, error: { message: "boom" } }).db)
    expect(r).toEqual({ listing: null, ok: false })
  })

  it("a thrown read is ok:false", async () => {
    const r = await fetchCandyFloorListing(
      "ed-1",
      dbFrom(() => {
        throw new Error("socket")
      }).db,
    )
    expect(r).toEqual({ listing: null, ok: false })
  })
})

describe("fetchCandyMarketHistory", () => {
  it("maps rows, keeps an unknown listed count NULL (not 0), and defaults offerCount to 0", async () => {
    const { db, rpcCalls } = dbRpc({
      data: [
        { day: "2026-11-25", floor_ask_usd: "5.25", listed_count: 3, best_offer_usd: null, offer_count: null },
        { day: "2026-11-24", floor_ask_usd: "", listed_count: null, best_offer_usd: "1.5", offer_count: "2" },
        { day: null, floor_ask_usd: 9 },
      ],
      error: null,
    })
    const r = await fetchCandyMarketHistory("ed-9", 30, db)
    expect(rpcCalls).toEqual([["get_candy_edition_market_history", { p_edition_id: "ed-9", p_days: 30 }]])
    expect(r.ok).toBe(true)
    expect(r.rows).toEqual([
      { day: "2026-11-25", floorAskUsd: 5.25, listedCount: 3, bestOfferUsd: null, offerCount: 0 },
      { day: "2026-11-24", floorAskUsd: null, listedCount: null, bestOfferUsd: 1.5, offerCount: 2 },
    ])
  })

  it("a non-array payload is an empty (ok) history", async () => {
    const r = await fetchCandyMarketHistory("ed-9", 60, dbRpc({ data: null, error: null }).db)
    expect(r).toEqual({ ok: true, rows: [] })
  })

  it("a FAILED or thrown read is ok:false, never 'no history'", async () => {
    expect(await fetchCandyMarketHistory("ed-9", 60, dbRpc({ data: [], error: { message: "x" } }).db)).toEqual({ ok: false, rows: [] })
    expect(
      await fetchCandyMarketHistory(
        "ed-9",
        60,
        dbRpc(() => {
          throw new Error("x")
        }).db,
      ),
    ).toEqual({ ok: false, rows: [] })
  })
})

describe("fetchCandyScarcityRow", () => {
  it("returns this edition's holders / circulating, NULL where unknown", async () => {
    const { db, calls, tables } = dbFrom({ data: [{ holders: "12", circulating: null }], error: null })
    const r = await fetchCandyScarcityRow("ext-1", db)
    expect(tables).toEqual(["mv_candy_scarcity_board"])
    expect(calls).toContainEqual(["eq", ["external_id", "ext-1"]])
    expect(r).toEqual({ ok: true, row: { holders: 12, circulating: null } })
  })

  it("no row is ok:true with row null; a failed or thrown read is ok:false", async () => {
    expect(await fetchCandyScarcityRow("ext-1", dbFrom({ data: [], error: null }).db)).toEqual({ ok: true, row: null })
    expect(await fetchCandyScarcityRow("ext-1", dbFrom({ data: null, error: { message: "x" } }).db)).toEqual({ ok: false, row: null })
    expect(
      await fetchCandyScarcityRow(
        "ext-1",
        dbFrom(() => {
          throw new Error("x")
        }).db,
      ),
    ).toEqual({ ok: false, row: null })
  })
})
