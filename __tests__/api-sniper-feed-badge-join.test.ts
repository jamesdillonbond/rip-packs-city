import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/sniper-feed — the badge join rewritten by fa1d356 (2026-08-01).
//
// What was broken, and why it needs a behavioural test rather than a smoke one:
//
//  * fetchBadgesByPlayers() keyed badge_editions by PLAYER NAME. Badges are a
//    property of a PLAY, so that grain would badge every edition of a player —
//    except nothing consumed the map at all: `hasBadge` was computed from
//    `l.tags`, a RawListing field that is declared and NEVER assigned. So
//    `hasBadge` was false for every Top Shot row on BOTH legs.
//  * ts_listings is effectively a dead table, so `tsListings.length` is always
//    under TS_GQL_SPARSE_THRESHOLD and the get_topshot_sniper_deals augment
//    fires on every request. Those rpcDeals are merged in AFTER the enrichment
//    loop, so they never met `if (badgeOnly && !hasBadge) continue`.
//  * Net effect: ticking "Badges only" dropped the ts_listings leg entirely and
//    passed ~200 unfiltered, all-flagged-unbadged RPC rows straight through — a
//    silent no-op that returned exclusively UN-badged moments. That is the
//    fabricated-signal class: the control claimed a filter it never applied.
//
// The rewrite keys badge_editions by external_id ("setID:playID"), which matches
// BOTH the ts_listings edition key and the RPC's moment_id, and applies the
// predicate to the RPC rows too. These tests pin the join, the filter actually
// filtering, and the honest drop of per-serial predicates at edition grain.

const fx = vi.hoisted(() => ({ tables: {} as Record<string, any>, client: null as any }))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) => factory(),
  deleteCache: () => {},
}))
// makeSupabaseFixture captures its fixtures object BY REFERENCE, so it is handed
// fx.tables itself and seed() mutates that object in place — a plain
// reassignment would silently detach it and every table would read empty (the
// bug documented in api-sniper-feed-compute.test.ts).
//
// ⚠ The CLIENT is rebuilt per seed, not built once. A SEQUENCE fixture (an array
// of payloads, one consumed per call — how the paged badge reads below are
// driven) keeps its cursor inside the fixture instance, and that cursor is NOT
// reset by clearing fx.tables. Built once, the third test to use a sequence
// starts mid-array and silently gets the LAST entry on its first read, which
// reds a correct route. Plain-object fixtures never noticed because they ignore
// the cursor entirely.
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    from: (table: string) => (fx.client as any).from(table),
    rpc: (name: string, args?: unknown) => (fx.client as any).rpc(name, args),
  },
}))
// The real guard shape: the route reads g.effectiveFmv / g.lowConfidenceFmv.
vi.mock("@/lib/fmv-display-guard", () => ({
  loadTopshotFmvGuard: async () => new Map(),
  guardTopshotFmv: (_m: unknown, _k: unknown, fmv: number) => ({
    effectiveFmv: fmv,
    lowConfidenceFmv: false,
  }),
}))

const { GET } = await import("@/app/api/sniper-feed/route")
const get = (qs = "") => new Request(`https://t/api/sniper-feed${qs}`)

// get_topshot_sniper_deals is EDITION-level: moment_id is the "setID:playID"
// edition key and serial_number is NULL on every live row.
function rpcDeal(momentId: string, over: Record<string, unknown> = {}) {
  return {
    flow_id: `F-${momentId}`,
    moment_id: momentId,
    player_name: `Player ${momentId}`,
    team_name: "",
    set_name: "Base Set",
    series_name: "4",
    tier: "COMMON",
    circulation_count: 1000,
    serial_number: null,
    ask_price: 10,
    fmv_usd: 100,
    confidence: "HIGH",
    thumbnail_url: null,
    listed_at: "2026-07-20T00:00:00Z",
    buy_url: "https://nbatopshot.com/x",
    listing_resource_id: null,
    ...over,
  }
}

function badgeRow(externalId: string | null, tags: Array<{ id?: string; title?: string }>) {
  return {
    external_id: externalId,
    player_name: "Someone",
    play_tags: tags,
    set_play_tags: null,
  }
}

function seed(over: Record<string, any> = {}) {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  Object.assign(fx.tables, {
    ts_listings: { data: [] },
    "rpc:get_topshot_sniper_deals": { data: [], error: null },
    badge_editions: { data: [], error: null },
    ...over,
  })
  fx.client = makeSupabaseFixture(fx.tables)
}

beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
  fx.client = makeSupabaseFixture(fx.tables)
})

const byMoment = (deals: any[]) =>
  Object.fromEntries(deals.map((d) => [d.momentId, d]))

describe("sniper-feed — badge_editions joined by EDITION KEY, not player name", () => {
  it("stamps hasBadge/badgeSlugs/badgeLabels onto the RPC rows that join", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [rpcDeal("1:100"), rpcDeal("1:101")],
        error: null,
      },
      badge_editions: {
        data: [badgeRow("1:100", [{ id: "rookie_mint", title: "Rookie Mint" }])],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    const deals = byMoment(body.deals)
    expect(deals["1:100"].hasBadge).toBe(true)
    expect(deals["1:100"].badgeSlugs).toEqual(["rookie_mint"])
    // The human-facing label comes from BADGE_LABELS, not the raw slug.
    expect(deals["1:100"].badgeLabels).toEqual(["Rookie Mint"])
    // The un-joined edition stays honestly unbadged rather than inheriting its
    // player's badges (the grain bug the rewrite removed).
    expect(deals["1:101"].hasBadge).toBe(false)
    expect(deals["1:101"].badgeSlugs).toEqual([])
  })

  it("badgeOnly=true now actually FILTERS the RPC rows (previously a silent no-op)", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [rpcDeal("1:100"), rpcDeal("1:101"), rpcDeal("1:102")],
        error: null,
      },
      badge_editions: {
        data: [
          badgeRow("1:100", [{ id: "mvp", title: "MVP Year" }]),
          badgeRow("1:102", [{ id: "fresh", title: "Fresh" }]),
        ],
        error: null,
      },
    })

    const all = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(all.deals).toHaveLength(3)

    const only = await (await GET(get("?collection=nba-top-shot&badgeOnly=true"))).json()
    // Neither 0 (the old ts_listings-leg behaviour) nor 3 (the old RPC-leg
    // behaviour) — a real, populated, honest subset.
    expect(only.deals.map((d: any) => d.momentId).sort()).toEqual(["1:100", "1:102"])
    expect(only.deals.every((d: any) => d.hasBadge)).toBe(true)
  })

  it("an UNRECOGNIZED tag is not a badge — the play-tag allowlist still applies", async () => {
    // badge_editions mixes ~6 real badges with gameplay descriptors. A row that
    // joins but carries only descriptors must stay unbadged, or the board
    // sprouts fake badges (the fabricated-signal class).
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("1:100")], error: null },
      badge_editions: {
        data: [badgeRow("1:100", [{ id: "crossover", title: "Crossover" }])],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals[0].hasBadge).toBe(false)
    const only = await (await GET(get("?collection=nba-top-shot&badgeOnly=true"))).json()
    expect(only.deals).toHaveLength(0)
  })

  it("skips badge rows with a blank/null external_id instead of keying on empty string", async () => {
    // A null external_id keyed as "" would collide every such row onto one
    // bucket and could badge an edition whose key normalises to empty.
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("1:100")], error: null },
      badge_editions: {
        data: [
          badgeRow(null, [{ id: "mvp", title: "MVP Year" }]),
          badgeRow("   ", [{ id: "fresh", title: "Fresh" }]),
        ],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals[0].hasBadge).toBe(false)
  })

  it("a badge_editions read ERROR degrades to an unbadged board, never a 500", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("1:100")], error: null },
      badge_editions: { data: null, error: { message: "badge_editions denied" } },
    })

    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.deals[0].hasBadge).toBe(false)
    // And badgeOnly then honestly returns nothing rather than pretending.
    const only = await (await GET(get("?collection=nba-top-shot&badgeOnly=true"))).json()
    expect(only.deals).toHaveLength(0)
  })
})

describe("sniper-feed — per-serial predicates at edition grain", () => {
  it("serial=special DROPS the edition-level RPC rows rather than passing them through", async () => {
    // get_topshot_sniper_deals returns serial_number NULL on every row, so an
    // edition row can NEVER satisfy a per-serial predicate. Passing them through
    // is precisely what made "Special serials" a no-op; dropping them is the
    // honest answer, even though it yields an empty board.
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [rpcDeal("1:100"), rpcDeal("1:101")],
        error: null,
      },
    })

    const body = await (await GET(get("?collection=nba-top-shot&serial=special"))).json()
    expect(body.deals).toHaveLength(0)
  })

  it("serial=jersey drops them too", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("1:100")], error: null },
    })
    const body = await (await GET(get("?collection=nba-top-shot&serial=jersey"))).json()
    expect(body.deals).toHaveLength(0)
  })

  it("no serial filter leaves the edition rows on the board", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("1:100")], error: null },
    })
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals).toHaveLength(1)
    expect(body.deals[0].serial).toBe(0)
  })

  it("an RPC row with no usable FMV is dropped — a $0.00 fair value is never rendered", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": {
        data: [rpcDeal("1:100", { fmv_usd: 0 }), rpcDeal("1:101", { fmv_usd: null }), rpcDeal("1:102")],
        error: null,
      },
    })
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals.map((d: any) => d.momentId)).toEqual(["1:102"])
  })

  it("an RPC ERROR yields an empty feed rather than a 500", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": { data: null, error: { message: "rpc down" } },
    })
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect((await res.json()).deals).toHaveLength(0)
  })
})

describe("sniper-feed — the badge map pages past PostgREST's 1000-row cap", () => {
  // ⚠ MEASURED, NOT HYPOTHETICAL. This read was a bare `.select()` justified by
  // a comment calling badge_editions "a small table (hundreds of rows)" against
  // a then-measured 4,981. Re-measured 2026-09-02: **9,471 Top Shot rows**, so
  // PostgREST returned 1,000 of them — 10.6% — and `hasBadge` was false for
  // ~89% of the editions that actually carry a badge. Nothing errors and no
  // page comes back short: the read SUCCEEDS and the map is simply wrong.
  //
  // The source-shape pins live in sniper-feed-capped-reads-stay-paged.test.ts.
  // These are the behavioural half: a badge that only exists on page TWO has to
  // reach the deal, which a single-page read cannot do however it is spelled.

  const FULL_PAGE = 1000

  /** A full first page of rows that carry no badge, so only page 2 can badge. */
  const fillerPage = () =>
    Array.from({ length: FULL_PAGE }, (_, i) => badgeRow(`filler:${i}`, []))

  it("stamps a badge that only exists on the SECOND page", async () => {
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("9:900")], error: null },
      badge_editions: [
        { data: fillerPage(), error: null },
        { data: [badgeRow("9:900", [{ id: "rookie_mint", title: "Rookie Mint" }])], error: null },
      ],
    })
    const body = await (await GET(get("?collection=nba-top-shot&minDiscount=0&maxPrice=0"))).json()
    const d = byMoment(body.deals)["9:900"]
    expect(d, "the RPC row should be on the board").toBeTruthy()
    expect(d.hasBadge).toBe(true)
    expect(d.badgeLabels).toContain("Rookie Mint")
  })

  it("the badgeOnly FILTER also sees page-two badges", async () => {
    // The worse consequence: with the cap in place, "Badges only" hid ~89% of
    // the badged listings that exist and the board read as almost empty — a
    // control claiming a filter it applied against a truncated map.
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("9:900"), rpcDeal("9:901")], error: null },
      badge_editions: [
        { data: fillerPage(), error: null },
        { data: [badgeRow("9:900", [{ id: "rookie_mint", title: "Rookie Mint" }])], error: null },
      ],
    })
    const body = await (await GET(get("?collection=nba-top-shot&badgeOnly=true&minDiscount=0&maxPrice=0"))).json()
    const ids = body.deals.map((d: any) => d.momentId)
    expect(ids).toContain("9:900")
    expect(ids).not.toContain("9:901")
  })

  it("NO-CHANGE CONTROL: a SHORT first page still badges, and does not need a second", async () => {
    // The mirror direction — the common case must not regress, and the loop
    // must stop on a short page rather than paging until MAX_PAGES.
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("1:100")], error: null },
      badge_editions: [
        { data: [badgeRow("1:100", [{ id: "rookie_mint", title: "Rookie Mint" }])], error: null },
        // If the loop asks for a second page after a SHORT one, it consumes
        // this and would wrongly badge 1:101 too.
        { data: [badgeRow("1:101", [{ id: "top_shot_debut", title: "Top Shot Debut" }])], error: null },
      ],
    })
    const body = await (await GET(get("?collection=nba-top-shot&minDiscount=0&maxPrice=0"))).json()
    const d = byMoment(body.deals)["1:100"]
    expect(d.hasBadge).toBe(true)
    expect(d.badgeLabels).toContain("Rookie Mint")
  })

  it("a page read that ERRORS mid-walk keeps the rows it already has", async () => {
    // Enrichment, so a partial map is better than none — but it must not throw
    // and take the whole board with it.
    seed({
      "rpc:get_topshot_sniper_deals": { data: [rpcDeal("9:900")], error: null },
      badge_editions: [
        { data: [...fillerPage().slice(0, FULL_PAGE - 1), badgeRow("9:900", [{ id: "rookie_mint", title: "Rookie Mint" }])], error: null },
        { data: null, error: { message: "canceling statement due to statement timeout" } },
      ],
    })
    const res = await GET(get("?collection=nba-top-shot&minDiscount=0&maxPrice=0"))
    expect(res.status).toBe(200)
    const d = byMoment((await res.json()).deals)["9:900"]
    expect(d.hasBadge).toBe(true)
  })
})
