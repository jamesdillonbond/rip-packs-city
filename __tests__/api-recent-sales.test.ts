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
  fmv: { data: any; error: any }
  eqCalls: Array<[string, any]>
  inCalls: Array<[string, any]>
  limitArg: number | null
  table: string | null
} = {
  sales: { data: [], error: null },
  edition: { data: null },
  fmv: { data: [], error: null },
  eqCalls: [],
  inCalls: [],
  limitArg: null,
  table: null,
}

vi.mock("@supabase/supabase-js", () => {
  const b: any = {
    select: () => b,
    eq: (col: string, val: any) => {
      state.eqCalls.push([col, val])
      return b
    },
    in: (col: string, vals: any) => {
      state.inCalls.push([col, vals])
      return b
    },
    order: () => b,
    limit: (n: number) => {
      state.limitArg = n
      return b
    },
    maybeSingle: async () => state.edition,
    // The route awaits three tables in sequence (editions via maybeSingle, then
    // sales, then fmv_current); `from` records the current table so a bare await
    // resolves the right fixture.
    then: (resolve: any) => resolve(state.table === "fmv_current" ? state.fmv : state.sales),
  }
  return { createClient: () => ({ from: (t: string) => { state.table = t; return b } }) }
})

import { GET } from "@/app/api/recent-sales/route"

const req = (url: string) => ({ nextUrl: new URL(url) }) as any

beforeEach(() => {
  state.sales = { data: [], error: null }
  state.edition = { data: null }
  state.fmv = { data: [], error: null }
  state.eqCalls = []
  state.inCalls = []
  state.limitArg = null
  state.table = null
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
          editions: { external_id: "73:2785", player_name: "LeBron James", set_name: "Base Set" },
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
      playerName: "LeBron James",
      setName: "Base Set",
    })
  })

  it("hydrates playerName / setName from the editions embed and fmv from fmv_current", async () => {
    state.sales = {
      data: [
        { serial_number: 1, price_usd: 9, sold_at: "2026-07-12T00:00:00Z", marketplace: "topshot", nft_id: "n1", edition_id: "e1", editions: { external_id: "1:1", player_name: "Jayson Tatum", set_name: "For the Win" } },
        { serial_number: 2, price_usd: 3, sold_at: "2026-07-11T00:00:00Z", marketplace: "topshot", nft_id: "n2", edition_id: "e2", editions: { external_id: "2:2", player_name: "Luke Kornet", set_name: "Base Set" } },
      ],
      error: null,
    }
    // numeric-string fmv (PostgREST returns numeric as string) must be coerced
    state.fmv = { data: [{ edition_id: "e1", fmv_usd: "7.0000" }, { edition_id: "e2", fmv_usd: "1.0000" }], error: null }
    const res = await GET(req("https://t/api/recent-sales?collectionId=nba-top-shot"))
    const body = await res.json()
    // the fmv lookup batched exactly the returned edition_ids
    expect(state.inCalls).toContainEqual(["edition_id", ["e1", "e2"]])
    expect(body.sales[0]).toMatchObject({ playerName: "Jayson Tatum", setName: "For the Win", fmv: 7 })
    expect(body.sales[1]).toMatchObject({ playerName: "Luke Kornet", setName: "Base Set", fmv: 1 })
  })

  it("leaves fmv null when fmv_current has no row for the edition", async () => {
    state.sales = {
      data: [{ serial_number: 1, price_usd: 9, sold_at: "2026-07-12T00:00:00Z", marketplace: "topshot", nft_id: "n1", edition_id: "e1", editions: { external_id: "1:1", player_name: "X", set_name: "Y" } }],
      error: null,
    }
    state.fmv = { data: [], error: null } // no FMV snapshot for e1
    const res = await GET(req("https://t/api/recent-sales"))
    const body = await res.json()
    expect(body.sales[0].fmv).toBeNull()
  })

  it("skips the fmv_current query entirely when no row carries an edition_id", async () => {
    state.sales = {
      data: [{ serial_number: 1, price_usd: 9, sold_at: "2026-07-12T00:00:00Z", marketplace: "topshot", nft_id: "n1", edition_id: null, editions: null }],
      error: null,
    }
    const res = await GET(req("https://t/api/recent-sales"))
    const body = await res.json()
    expect(state.inCalls).toHaveLength(0)
    expect(body.sales[0]).toMatchObject({ playerName: null, setName: null, fmv: null })
  })

  it("500s on a sales query error", async () => {
    state.sales = { data: null, error: { message: "Database query failed" } }
    const res = await GET(req("https://t/api/recent-sales?collectionId=nba-top-shot"))
    expect(res.status).toBe(500)
    // The driver message must NOT be published — lib/api-error.ts classifies it.
    expect((await res.json()).error).not.toContain("Database query failed")
  })

  it("clamps limit to 50 max", async () => {
    await GET(req("https://t/api/recent-sales?limit=999"))
    expect(state.limitArg).toBe(50)
  })

  it("uses the requested limit when under the cap", async () => {
    await GET(req("https://t/api/recent-sales?limit=5"))
    expect(state.limitArg).toBe(5)
  })

  it("falls back to the default limit on a malformed ?limit (never passes NaN to PostgREST)", async () => {
    // parseInt("abc") is NaN; the old Math.min(NaN,50) reached .limit(NaN),
    // which PostgREST 400s → a 500 on this public route. Degrade to 15 instead.
    const res = await GET(req("https://t/api/recent-sales?limit=abc"))
    expect(res.status).toBe(200)
    expect(state.limitArg).toBe(15)
  })

  it("falls back to the default limit on a non-positive ?limit", async () => {
    await GET(req("https://t/api/recent-sales?limit=0"))
    expect(state.limitArg).toBe(15)
    await GET(req("https://t/api/recent-sales?limit=-5"))
    expect(state.limitArg).toBe(15)
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

  // This case previously asserted that an unknown slug "applies no collection scope" —
  // i.e. it PINNED the bug as correct behaviour. With both lookups missing, collectionUuid
  // went null, the .eq("collection_id", …) was skipped, and the route answered 200 with the
  // globally-newest sales (overwhelmingly Top Shot) while echoing the bogus slug back as
  // `collectionId`, so the payload looked authoritative. Verified in the browser against
  // production: ?collectionId=TOTALLY-BOGUS-SLUG-xyz returned WNBA Top Shot moments.
  it("returns empty for an unknown collection slug rather than global sales", async () => {
    state.sales = {
      data: [
        { serial_number: 1, price_usd: 9, sold_at: "2026-07-12T00:00:00Z", marketplace: "topshot", nft_id: "n1", edition_id: "e1", editions: { external_id: "1:1", player_name: "Leaked Row", set_name: "Base Set" } },
      ],
      error: null,
    }
    const res = await GET(req("https://t/api/recent-sales?collectionId=not-real"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sales).toEqual([])
    expect(body.collectionId).toBe("not-real")
    // Short-circuits BEFORE touching the DB — no unscoped sales query is ever issued.
    expect(state.eqCalls.some(([c]) => c === "collection_id")).toBe(false)
    expect(state.limitArg).toBeNull()
  })

  // The guard keys on the RAW param, so omitting collectionId still defaults to
  // nba-top-shot and scopes normally (back-compat for /profile, which relies on it).
  it("still defaults to a scoped nba-top-shot query when collectionId is omitted", async () => {
    await GET(req("https://t/api/recent-sales"))
    expect(state.eqCalls.some(([c]) => c === "collection_id")).toBe(true)
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

// ── AN UNRESOLVED editionKey MUST NOT ANSWER WITH SOMEONE ELSE'S SALES ──────
//
// 2026-09-04. The resolve was `const { data: editionRow } = await q.maybeSingle()`
// — `error` discarded — followed by `if (editionRow) editionIdFilter = …`. On a
// failed or missed lookup the filter stayed null, the `.eq("edition_id", …)` was
// SKIPPED, and the route answered 200 with collection-wide (or global) recent
// sales for a request that asked for ONE edition.
//
// ⭐ That is the exact shape the comment TEN LINES ABOVE it already forbids for
// the sibling `collectionId` param — "the response looks authoritative. That is a
// fabricated-data shape. Return empty instead." It was understood, and applied to
// one parameter of the two.
//
// ⚠ Wrong data is worse than no data, which is why these cases assert the sales
// query was never ISSUED rather than merely that the body is empty: a response
// that is empty by luck would pass a body-only check.
describe("GET /api/recent-sales — an editionKey that does not resolve", () => {
  it("returns an honest error when the edition lookup FAILED", async () => {
    state.edition = { data: null, error: { message: "boom", code: "57014" } } as never
    const res = await GET(req("https://t/api/recent-sales?editionKey=73:2785&collectionId=nba-top-shot"))
    expect(res.status).toBeGreaterThanOrEqual(400)
    const body = await res.json()
    expect(body.sales).toBeUndefined()
    // We never fell through to the sales query at all. ⚠ NOT asserted via
    // eqCalls: the edition LOOKUP itself filters on collection_id, so that check
    // fails for a legitimate reason. `state.table` records the last `from()`.
    expect(state.table).toBe("editions")
  })

  it("returns an EMPTY list when the lookup succeeded and matched nothing", async () => {
    // Distinct from the failure above: this read worked, and an unknown edition
    // genuinely has no sales. Matches the collectionId branch's precedent.
    state.edition = { data: null, error: null } as never
    const res = await GET(req("https://t/api/recent-sales?editionKey=nope&collectionId=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sales).toEqual([])
    expect(body.collectionId).toBe("nba-top-shot")
    expect(state.table).toBe("editions")
  })

  it("still filters on edition_id when the lookup DOES resolve", async () => {
    // The control. Without it the two cases above are satisfied by a route that
    // simply never queries anything.
    state.edition = { data: { id: "ed-1" }, error: null } as never
    const res = await GET(req("https://t/api/recent-sales?editionKey=73:2785&collectionId=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(state.eqCalls).toContainEqual(["edition_id", "ed-1"])
  })
})
