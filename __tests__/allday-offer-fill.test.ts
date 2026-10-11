import { describe, it, expect, beforeEach, vi } from "vitest"

// lib/chains/flow/allday-offer-fill.ts — known-issues #70's lane. The point of
// these tests is the COUNT: trg_zzz_allday_cross_source_dedup folds a twin with
// RETURN NULL, so an insert can succeed and write nothing. Written / suppressed /
// duplicate must be told apart from what the DB RETURNED, and any other insert
// error must throw so the indexer holds its cursor.

const state = vi.hoisted(() => ({
  insertResults: [] as Array<{ data: unknown; error: { code?: string; message: string } | null }>,
  inserts: [] as unknown[],
  editions: [] as unknown[],
  moments: [] as unknown[],
  wmc: [] as unknown[],
}))

function builder(table: string) {
  let op = "select"
  let row: unknown = null
  const resolve = () => {
    if (table === "sales" && op === "insert") {
      state.inserts.push(row)
      return state.insertResults.shift() ?? { data: [{ id: "x" }], error: null }
    }
    if (table === "editions") return { data: state.editions, error: null }
    if (table === "moments") return { data: state.moments, error: null }
    if (table === "wallet_moments_cache") return { data: state.wmc, error: null }
    return { data: [], error: null }
  }
  const b: Record<string, unknown> = {}
  for (const m of ["select", "eq", "in"]) b[m] = () => b
  b.insert = (r: unknown) => { op = "insert"; row = r; return b }
  b.then = (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, bad)
  return b
}
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: { from: (t: string) => builder(t) } }))

import { parseAllDayOfferFill, writeAllDayOfferFillSales, type AllDayOfferFill } from "@/lib/chains/flow/allday-offer-fill"

const fill = (over: Partial<AllDayOfferFill> = {}): AllDayOfferFill => ({
  offerId: "1", fillTx: "tx1", blockTs: "2026-10-10T00:00:00Z", blockHeight: 10,
  buyer: "0xbb", seller: "0xss", amount: 5, nftId: "555", editionExternalId: "777", ...over,
})

beforeEach(() => {
  state.insertResults = []
  state.inserts = []
  state.editions = [{ external_id: "777", id: "uuid-777" }]
  state.moments = []
  state.wmc = []
})

describe("parseAllDayOfferFill", () => {
  it("returns null for a cancel (purchased !== true) and a non-positive amount", () => {
    expect(parseAllDayOfferFill({ purchased: false, offerId: "1", offerAmount: "5" }, "tx", "t", 1)).toBeNull()
    expect(parseAllDayOfferFill({ purchased: true, offerId: "1", offerAmount: "0" }, "tx", "t", 1)).toBeNull()
  })
  it("reads buyer = offerAddress, seller = acceptingAddress, the nft, and an EDITION offer's editionId", () => {
    const f = parseAllDayOfferFill(
      { purchased: true, offerId: "9", offerAmount: "12.5", offerAddress: "0xAB", acceptingAddress: "CD", nftId: 42, offerParamsString: { _type: "EDITION", editionId: 777 } },
      "tx9", "2026-10-10T00:00:00Z", 100,
    )
    expect(f).toMatchObject({ offerId: "9", buyer: "0xab", seller: "0xcd", amount: 12.5, nftId: "42", editionExternalId: "777" })
  })
})

describe("writeAllDayOfferFillSales", () => {
  it("classifies written / suppressed-by-dedup / duplicate from what the DB returned", async () => {
    state.insertResults = [
      { data: [{ id: "a" }], error: null }, // written
      { data: [], error: null }, // trigger RETURN NULL
      { data: null, error: { code: "23505", message: "dup" } }, // already there
    ]
    const out = await writeAllDayOfferFillSales([fill({ fillTx: "t1" }), fill({ fillTx: "t2" }), fill({ fillTx: "t3" })])
    expect(out).toEqual({ written: 1, suppressed: 1, duped: 1, unresolved: 0 })
  })

  it("an unplaceable fill is skipped and counted, never inserted with a NULL edition", async () => {
    state.editions = []
    const out = await writeAllDayOfferFillSales([fill({ editionExternalId: null, nftId: "999" })])
    expect(out).toEqual({ written: 0, suppressed: 0, duped: 0, unresolved: 1 })
    expect(state.inserts).toHaveLength(0)
  })

  it("places a non-EDITION offer through the nft (wallet cache) and writes a NULL — never 0 — serial when unknown", async () => {
    state.editions = [{ external_id: "888", id: "uuid-888" }]
    state.wmc = [{ moment_id: "555", edition_key: "888", serial_number: null }]
    await writeAllDayOfferFillSales([fill({ editionExternalId: null })])
    expect(state.inserts[0]).toMatchObject({ edition_id: "uuid-888", serial_number: null, source: "offer_fill" })
  })

  it("THROWS on a non-duplicate insert error so the indexer holds its cursor", async () => {
    state.insertResults = [{ data: null, error: { code: "XX000", message: "boom" } }]
    await expect(writeAllDayOfferFillSales([fill()])).rejects.toThrow(/offer_fill sale insert failed/)
  })
})
