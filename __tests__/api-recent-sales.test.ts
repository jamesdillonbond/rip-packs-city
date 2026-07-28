import { describe, it, expect, beforeEach, vi } from "vitest"

// Route integration test for /api/recent-sales (GET, public, no pre-DB guard).
// Mocks the @supabase/supabase-js createClient seam: a thenable query builder
// resolves the terminal sales query and .maybeSingle() the optional edition
// lookup. getCollection / COLLECTION_UUID_BY_SLUG stay real (pure). Pins the
// mapped happy path, the query-error → 500, and (2026-07-28 Gap-C error-leg
// pass) the previously-dark branches: the editionKey → edition_id resolve path,
// the limit clamp, the null external_id fallback, and the unknown-collection
// (no collectionUuid) branch.

const state: {
  sales: { data: any; error: any }
  edition: { data: any }
  eqCalls: Array<[string, any]>
  limitArg: number | null
} = {
  sales: { data: [], error: null },
  edition: { data: null },
  eqCalls: [],
  limitArg: null,
}

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: (col: string, val: any) => {
      state.eqCalls.push([col, val])
      return b
    },
    order: () => b,
    limit: (n: number) => {
      state.limitArg = n
      return b
    },
    maybeSingle: async () => state.edition,
    then: (resolve: any) => resolve(state.sales),
  }
  return { createClient: () => ({ from: () => b }) }
})

import { GET } from "@/app/api/recent-sales/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.sales = { data: [], error: null }
  state.edition = { data: null }
  state.eqCalls = []
  state.limitArg = null
})

describe("GET /api/recent-sales", () => {
  it("maps sales rows and defaults collectionId to nba-top-shot", async () => {
    state.sales = {
      data: [
        {
          serial_number: 7,
          price_usd: 42,
          sold_at: "2026-07-12T00:00:00Z",
          marketplace: "topshot",
          nft_id: "n1",
          edition_id: "e1",
          editions: { external_id: "73:2785" },
        },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/recent-sales"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.collectionId).toBe("nba-top-shot")
    expect(body.sales).toHaveLength(1)
    expect(body.sales[0]).toMatchObject({
      serialNumber: 7,
      price: 42,
      marketplace: "topshot",
      editionKey: "73:2785",
    })
  })

  it("500s on a sales query error", async () => {
    state.sales = { data: null, error: { message: "Database query failed" } }
    const res = await GET(req("https://t/api/recent-sales?collectionId=nba-top-shot"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("Database query failed")
  })

  it("clamps limit to 50 max", async () => {
    await GET(req("https://t/api/recent-sales?limit=999"))
    expect(state.limitArg).toBe(50)
  })

  it("uses the requested limit when under the cap", async () => {
    await GET(req("https://t/api/recent-sales?limit=5"))
    expect(state.limitArg).toBe(5)
  })

  it("resolves editionKey to an edition_id filter and scopes sales by it", async () => {
    state.edition = { data: { id: "edn-123" } }
    await GET(req("https://t/api/recent-sales?editionKey=73:2785&collectionId=nba-top-shot"))
    // the terminal sales query is filtered by edition_id (collection_id also
    // appears, but only from the edition-lookup query, not the sales scope)
    expect(state.eqCalls).toContainEqual(["edition_id", "edn-123"])
    // the edition lookup scoped by external_id + collection_id
    expect(state.eqCalls).toContainEqual(["external_id", "73:2785"])
  })

  it("falls back to collection_id scope when the editionKey does not resolve", async () => {
    state.edition = { data: null } // unresolved edition row
    await GET(req("https://t/api/recent-sales?editionKey=nope&collectionId=nba-top-shot"))
    // no edition_id filter; collection_id scope applied instead
    expect(state.eqCalls.some(([c]) => c === "edition_id")).toBe(false)
    expect(state.eqCalls.some(([c]) => c === "collection_id")).toBe(true)
  })

  it("applies no collection scope for an unknown collection slug", async () => {
    await GET(req("https://t/api/recent-sales?collectionId=not-real"))
    // collectionUuid null → neither edition_id nor collection_id .eq on the sales query
    expect(state.eqCalls.some(([c]) => c === "collection_id")).toBe(false)
  })

  it("maps a null external_id to editionKey null (no embed row)", async () => {
    state.sales = {
      data: [
        {
          serial_number: 1,
          price_usd: 5,
          sold_at: "2026-07-12T00:00:00Z",
          marketplace: "topshot",
          nft_id: "n2",
          edition_id: "e2",
          editions: null,
        },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/recent-sales"))
    const body = await res.json()
    expect(body.sales[0].editionKey).toBeNull()
  })
})
