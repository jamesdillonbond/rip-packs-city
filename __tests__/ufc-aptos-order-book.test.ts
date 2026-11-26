// /ufc/analytics' Order Book Depth read Flow listings only and said "No live listings." beside
// ~465 live Aptos asks (2026-11-26). The UFC row is now the live Aptos book; a failed Aptos read
// fails the request (the card's "couldn't load"), never an empty book.
import { describe, it, expect, vi, beforeEach } from "vitest"

const state: { rpc: any; feed: () => Promise<any> } = {
  rpc: { data: null, error: null },
  feed: async () => ({ deals: [] }),
}
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))
vi.mock("@/lib/analytics/rpc-with-retry", () => ({ rpcWithRetry: async () => state.rpc }))
vi.mock("@/lib/sniper/ufc-aptos", () => ({ computeUfcAptosSniperFeed: (...a: any[]) => (state.feed as any)(...a) }))

import { summarizeUfcAptosBook, withUfcAptosBook } from "@/lib/analytics/ufc-aptos-book"
import { GET } from "@/app/api/analytics/listings/summary/route"

const req = (q: string) => ({ url: "http://x/api/analytics/listings/summary" + q }) as any
const BASE = { loan_offers: {}, topshot_orderbook: {}, marketplace_listings: [{ collection: "ufc", count: 0 }, { collection: "allday", count: 9 }] }

beforeEach(() => {
  state.rpc = { data: JSON.parse(JSON.stringify(BASE)), error: null }
  state.feed = async () => ({ deals: [1, 2, 3, 4, 10].map((askPrice) => ({ askPrice })) })
})

describe("summarizeUfcAptosBook", () => {
  it("counts, medians and p90s the asks, tagged aptos", () => {
    expect(summarizeUfcAptosBook([3, 1, 2, 10, 4])).toMatchObject({
      collection: "ufc", count: 5, min_ask_usd: 1, max_ask_usd: 10, median_ask_usd: 3, p90_ask_usd: 10, chain: "aptos",
    })
    expect(summarizeUfcAptosBook([1, 3]).median_ask_usd).toBe(2)
  })
  it("an empty book is count 0 with no invented prices", () => {
    expect(summarizeUfcAptosBook([])).toMatchObject({ count: 0, median_ask_usd: null, p90_ask_usd: null })
  })
  it("replaces only the UFC row", () => {
    const out = withUfcAptosBook([{ collection: "UFC" }, { collection: "allday" }], { collection: "ufc", n: 1 } as any)
    expect(out).toEqual([{ collection: "allday" }, { collection: "ufc", n: 1 }])
    expect(withUfcAptosBook({}, { collection: "ufc" })).toEqual([{ collection: "ufc" }])
  })
})

describe("GET /api/analytics/listings/summary — UFC arm", () => {
  it("serves the Aptos book as the UFC row", async () => {
    const res = await GET(req("?collections=ufc"))
    expect(res.status).toBe(200)
    const body = await res.json()
    const ufc = body.marketplace_listings.find((r: any) => r.collection === "ufc")
    expect(ufc).toMatchObject({ count: 5, median_ask_usd: 3, chain: "aptos" })
    expect(body.marketplace_listings.find((r: any) => r.collection === "allday").count).toBe(9)
  })
  it("a failed Aptos read is a 500 — never 'No live listings.'", async () => {
    state.feed = async () => { throw new Error("ufc_aptos_listings: read hit the 1,000-row cap") }
    const res = await GET(req("?collections=ufc"))
    expect(res.status).toBe(500)
  })
  it("does not touch the Aptos book for other collections", async () => {
    const spy = vi.fn(async () => ({ deals: [] }))
    state.feed = spy
    const res = await GET(req("?collections=allday"))
    expect(res.status).toBe(200)
    expect(spy).not.toHaveBeenCalled()
  })
})
