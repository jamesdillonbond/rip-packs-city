import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — the PAGINATION TOTAL contract introduced by fa1d356
// (2026-08-01), plus the modern-branch in-memory sort the same commit flagged.
//
// The defect being pinned: the route asks PostgREST for { count: "exact" } and
// then reported `postFiltered.length` as `total`. Because the fetch window is
// only `offset + limit + 100` for non-discount sorts, `total` was effectively
// the WINDOW SIZE — so once a collection had more matching rows than the window,
// `total` and `hasMore` under-reported and the UI stopped paginating early. The
// fix resolves three cases explicitly and SAYS which one it is:
//
//   1. window held every matching row          -> post-filter count, exact
//   2. window truncated, nothing dropped in app -> the DB count, exact
//   3. window truncated AND rows dropped in app -> post-filter count, a FLOOR
//
// `totalIsExact === false` is the promise that consumers must render "N+" rather
// than "N". Getting case 2 wrong is the subtle one: it is the only case where
// `total` exceeds the number of rows the route actually looked at, so a naive
// implementation reporting `postFiltered.length` looks right in tests built on
// small fixtures and silently caps in production.

const state = vi.hoisted(() => ({ sb: null as unknown, throwOn: null as string | null }))

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy(
    {},
    { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] },
  ),
}))

import { GET } from "@/app/api/market/route"

const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const GOLAZOS = "06248cc4-b85f-47cd-af67-1855d14acd75"

const req = (u: string) => ({ nextUrl: new URL(u) }) as never

function install(fixtures: Record<string, unknown>) {
  const fx = makeSupabaseFixture(fixtures as never) as any
  if (state.throwOn) {
    const baseFrom = fx.from.bind(fx)
    fx.from = (t: string) => {
      if (t === state.throwOn) throw new Error("cached_listings blew up")
      return baseFrom(t)
    }
  }
  state.sb = fx
}

// Distinct player per row so collapseToEditions is 1:1 and `droppedInApp` is 0
// unless a test deliberately makes rows collide.
function listing(i: number, over: Record<string, unknown> = {}) {
  return {
    id: `L${i}`,
    flow_id: `F${i}`,
    moment_id: null,
    player_name: `Player ${i}`,
    set_name: "Base Set",
    series_name: "1",
    tier: "COMMON",
    ask_price: 10 + i,
    fmv: 100,
    confidence: "HIGH",
    serial_number: i + 2,
    circulation_count: 500,
    badge_slugs: [],
    listed_at: `2026-07-${String(10 + (i % 18)).padStart(2, "0")}T00:00:00Z`,
    collection_id: GOLAZOS,
    ...over,
  }
}

beforeEach(() => {
  state.sb = null
  state.throwOn = null
})

describe("GET /api/market — legacy path, the three total cases", () => {
  it("case 1: the window held every matching row -> total is the post-filter count and EXACT", async () => {
    const rows = [listing(0), listing(1), listing(2)]
    install({ cached_listings: { data: rows, error: null, count: 3 }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))).json()
    expect(body.pagination.total).toBe(3)
    expect(body.pagination.totalIsExact).toBe(true)
    expect(body.pagination.matchedBeforeFilters).toBe(3)
    expect(body.diagnostics.windowTruncated).toBe(false)
    expect(body.diagnostics.fetchedCount).toBe(3)
  })

  it("case 2: window truncated but nothing dropped in-app -> total is the DB COUNT, still exact", async () => {
    // THE regression this fix exists for. The window returned 3 rows; the DB says
    // 4,812 match. Reporting 3 is what made the UI stop paginating after page one.
    const rows = [listing(0), listing(1), listing(2)]
    install({ cached_listings: { data: rows, error: null, count: 4812 }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))).json()
    expect(body.pagination.total).toBe(4812)
    expect(body.pagination.totalIsExact).toBe(true)
    expect(body.pagination.matchedBeforeFilters).toBe(4812)
    expect(body.diagnostics.windowTruncated).toBe(true)
    // postFilterCount stays honest about what the route actually held.
    expect(body.diagnostics.postFilterCount).toBe(3)
    // hasMore is now driven by the real total, so page 1 of 4,812 keeps paging.
    expect(body.pagination.hasMore).toBe(true)
  })

  it("case 3: truncated AND rows dropped in-app -> total is a FLOOR, flagged not-exact", async () => {
    // Two listings of the SAME edition collapse to one row, so the DB count can
    // no longer be trusted as a total — and neither can the post-filter count.
    // The only honest answer is "at least N", which is what totalIsExact:false
    // tells the consumer to render as "N+".
    const rows = [
      listing(0, { player_name: "Same Guy" }),
      listing(1, { player_name: "Same Guy" }),
      listing(2),
    ]
    install({ cached_listings: { data: rows, error: null, count: 9000 }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))).json()
    expect(body.pagination.totalIsExact).toBe(false)
    expect(body.pagination.total).toBe(2) // collapsed: "Same Guy" + Player 2
    expect(body.pagination.matchedBeforeFilters).toBe(9000)
    expect(body.diagnostics.windowTruncated).toBe(true)
    expect(body.diagnostics.fetchedCount).toBe(3)
  })

  it("a missing PostgREST count degrades to the floor rather than inventing a total", async () => {
    // count omitted -> dbMatched null -> neither exactness proof is available.
    install({ cached_listings: { data: [listing(0), listing(1)], error: null }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))).json()
    expect(body.pagination.matchedBeforeFilters).toBeNull()
    expect(body.pagination.totalIsExact).toBe(false)
    expect(body.pagination.total).toBe(2)
    // rawCount falls back to the fetched length so the diagnostic is never null.
    expect(body.diagnostics.rawCount).toBe(2)
  })

  it("an in-app discount filter that drops rows forces the not-exact floor", async () => {
    // minDiscount runs in app code, after `count` was computed, so it is exactly
    // the class of filter that invalidates the DB count as a total.
    const rows = [
      listing(0, { ask_price: 10, fmv: 100 }), // 90% off — kept
      listing(1, { ask_price: 99, fmv: 100 }), // 1% off — dropped
    ]
    install({ cached_listings: { data: rows, error: null, count: 5000 }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}&minDiscount=50`))).json()
    expect(body.listings).toHaveLength(1)
    expect(body.pagination.total).toBe(1)
    expect(body.pagination.totalIsExact).toBe(false)
    expect(body.pagination.matchedBeforeFilters).toBe(5000)
  })

  it("FINDING: ?specialSerials=true on the legacy path can only ever return an EMPTY board", async () => {
    // Not a coverage filler — this documents live behaviour that is easy to
    // misread. Market is EDITION-level by design (Trevor, 2026-07-18), so
    // collapseToEditions unconditionally emits `serialNumber: null` and
    // `isSpecialSerial: false` for every collapsed row. The specialSerials
    // predicate then runs AFTER that collapse, so it matches nothing — a #1
    // serial in the source data is filtered out along with everything else.
    //
    // This is the same "per-serial predicate at edition grain is unsatisfiable"
    // situation fa1d356 resolved for sniper-feed's RPC rows, where it chose to
    // DROP them and remove the control rather than let it silently no-op. The
    // param survives here only as a directly-reachable query string (no UI
    // control references it — grepped across app/ and components/), so the
    // empty board is at least honest rather than a lie, but a caller expecting
    // "#1s only" gets zero results, not a filtered list.
    const rows = [
      listing(0, { serial_number: 1 }), // #1 in the source data...
      listing(1, { serial_number: 7 }),
    ]
    install({ cached_listings: { data: rows, error: null, count: 5000 }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}&specialSerials=true`))).json()
    expect(body.listings).toHaveLength(0) // ...and it is still dropped.
    expect(body.pagination.total).toBe(0)
    // The total is correctly flagged as a floor: rows WERE dropped in app code,
    // so the DB count cannot stand in as a total.
    expect(body.pagination.totalIsExact).toBe(false)
    expect(body.pagination.matchedBeforeFilters).toBe(5000)
  })

  it("discount_asc orders ascending and demotes thin-FMV rows below verified ones", async () => {
    // ASK_ONLY confidence => lowConfidenceFmv, which must sort LAST regardless of
    // its headline discount, so a fake ask-vs-ask bargain can never lead the page.
    const rows = [
      listing(0, { ask_price: 50, fmv: 100 }), // 50% off, verified
      listing(1, { ask_price: 90, fmv: 100 }), // 10% off, verified
      listing(2, { ask_price: 1, fmv: 100, confidence: "ASK_ONLY" }), // 99% off, THIN
    ]
    install({ cached_listings: { data: rows, error: null, count: 3 }, editions: { data: [], error: null } })

    const body = await (await GET(req(`https://t/api/market?collectionId=${GOLAZOS}&sort=discount_asc`))).json()
    expect(body.listings.map((r: any) => r.playerName)).toEqual(["Player 1", "Player 0", "Player 2"])
    expect(body.listings[2].lowConfidenceFmv).toBe(true)
  })

  it("500s with the error message when the whole query throws", async () => {
    state.throwOn = "cached_listings"
    install({ editions: { data: [], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${GOLAZOS}`))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain("cached_listings blew up")
  })
})

describe("GET /api/market — modern path total flagging + in-memory sort", () => {
  function modernRow(i: number, over: Record<string, unknown> = {}) {
    return {
      edition_id: `uuid-${i}`,
      external_id: `allday-ed-${i}`,
      player_name: `Player ${i}`,
      team_name: "Buffalo Bills",
      set_name: "Base Set",
      series_name: "1",
      tier: "MOMENT_TIER_RARE",
      circulation_count: 500,
      floor_ask: 10 + i,
      listed_count: 3,
      fmv_usd: 100,
      confidence: "HIGH",
      thumbnail_url: null,
      badges: [],
      last_listed_at: `2026-07-${String(10 + i).padStart(2, "0")}T00:00:00Z`,
      ...over,
    }
  }
  const modern = (rows: unknown[]) => ({
    "rpc:get_allday_market_editions": { data: rows, error: null },
    editions: { data: [], error: null },
  })

  it("a SHORT modern page is exact — the RPC saw everything there was", async () => {
    install(modern([modernRow(0), modernRow(1)]))
    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=10`))).json()
    expect(body.diagnostics.source).toBe("modern")
    expect(body.pagination.total).toBe(2)
    expect(body.pagination.totalIsExact).toBe(true)
    expect(body.diagnostics.windowTruncated).toBe(false)
    // The modern branch cannot see past its own page, so it never claims a
    // DB-level count.
    expect(body.pagination.matchedBeforeFilters).toBeNull()
  })

  it("a FULL modern page is flagged as a floor — the RPC is called WITH limit, so more may exist", async () => {
    install(modern([modernRow(0), modernRow(1), modernRow(2)]))
    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=3`))).json()
    expect(body.pagination.total).toBe(3)
    expect(body.pagination.totalIsExact).toBe(false)
    expect(body.diagnostics.windowTruncated).toBe(true)
  })

  it("re-sorts the modern feed in memory so the shown order matches the label", async () => {
    // The upstream sniper RPCs do not reliably honour every sort value, which is
    // what made the sort label lie. Each of these must be authoritative locally.
    const rows = [modernRow(0, { floor_ask: 30 }), modernRow(1, { floor_ask: 10 }), modernRow(2, { floor_ask: 20 })]
    const askOrder = async (sort: string) => {
      install(modern(rows))
      const b = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=10&sort=${sort}`))).json()
      return b.listings.map((r: any) => r.askPrice)
    }
    expect(await askOrder("price_asc")).toEqual([10, 20, 30])
    expect(await askOrder("price_desc")).toEqual([30, 20, 10])
  })

  it("fmv_asc / fmv_desc order on FMV, not on ask", async () => {
    const rows = [
      modernRow(0, { floor_ask: 5, fmv_usd: 300 }),
      modernRow(1, { floor_ask: 5, fmv_usd: 100 }),
      modernRow(2, { floor_ask: 5, fmv_usd: 200 }),
    ]
    const fmvOrder = async (sort: string) => {
      install(modern(rows))
      const b = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=10&sort=${sort}`))).json()
      return b.listings.map((r: any) => r.fmv)
    }
    expect(await fmvOrder("fmv_asc")).toEqual([100, 200, 300])
    expect(await fmvOrder("fmv_desc")).toEqual([300, 200, 100])
  })

  it("sort=recent orders by listedAt descending", async () => {
    install(
      modern([
        modernRow(0, { last_listed_at: "2026-07-10T00:00:00Z" }),
        modernRow(1, { last_listed_at: "2026-07-20T00:00:00Z" }),
        modernRow(2, { last_listed_at: "2026-07-15T00:00:00Z" }),
      ]),
    )
    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=10&sort=recent`))).json()
    expect(body.listings.map((r: any) => r.listedAt)).toEqual([
      "2026-07-20T00:00:00Z",
      "2026-07-15T00:00:00Z",
      "2026-07-10T00:00:00Z",
    ])
  })

  it("discount_asc on the modern feed demotes thin-FMV rows below verified ones", async () => {
    install(
      modern([
        modernRow(0, { floor_ask: 50, fmv_usd: 100 }),
        modernRow(1, { floor_ask: 90, fmv_usd: 100 }),
        modernRow(2, { floor_ask: 1, fmv_usd: 100, confidence: "ASK_ONLY" }),
      ]),
    )
    const body = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=10&sort=discount_asc`))).json()
    expect(body.listings.map((r: any) => r.discount)).toEqual([10, 50, 99])
    expect(body.listings[2].lowConfidenceFmv).toBe(true)
  })
})
