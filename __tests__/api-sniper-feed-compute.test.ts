import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// Phase 2 of the deep-loop layer: drive sniper-feed's REAL Top Shot compute
// (computeSniperFeed) instead of bypassing it. Discovery: the TS pool is
// Supabase-sourced (ts_listings), not a live GQL fetch, so makeSupabaseFixture
// alone drives fetchTopShotPool -> resolveEditionKeys -> the FMV/badge/jersey
// enrichment fan-out -> merge/sort. getOrSetCache is stubbed to RUN the factory
// (not return a canned result), and the FMV display guard is neutralized so the
// compute body executes end-to-end and returns a structured feed.

const fx = vi.hoisted(() => ({ tables: {} as Record<string, any> }))

vi.mock("@/lib/cache", () => ({
  getOrSetCache: async (_k: string, _ttl: number, factory: () => Promise<any>) => factory(),
  deleteCache: () => {},
}))
// makeSupabaseFixture captures its fixtures object BY REFERENCE, so a test doing
// `fx.tables = {...}` (reassignment) silently detaches it and the fixture keeps
// serving the original — every table then reads empty. That bug made the
// "populated pool" case below pass on ZERO deals. Hand the fixture a live view
// of fx.tables instead, so both reassignment and in-place mutation are seen.
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: makeSupabaseFixture(
    new Proxy({} as Record<string, any>, {
      get: (_t, k: string) => fx.tables[k],
      has: (_t, k: string) => k in fx.tables,
      ownKeys: () => Reflect.ownKeys(fx.tables),
      getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    }),
  ),
}))
vi.mock("@/lib/fmv-display-guard", () => ({
  loadTopshotFmvGuard: async () => new Map(),
  guardTopshotFmv: (fmv: number) => ({ fmv, clamped: false, thin: false }),
}))

const { GET } = await import("@/app/api/sniper-feed/route")
const get = (qs = "") => new Request(`https://t/api/sniper-feed${qs}`)

function tsListing(over: Record<string, any> = {}) {
  return {
    listing_id: "L1",
    flow_id: "F1",
    set_id: 1,
    play_id: 2,
    serial_number: 5,
    circulation_count: 1000,
    price_usd: 10,
    player_name: "Stephen Curry",
    set_name: "Base Set",
    moment_tier: "COMMON",
    series_number: 4,
    is_locked: false,
    listed_at: "2026-07-16T00:00:00Z",
    ingested_at: "2026-07-16T00:00:00Z",
    ...over,
  }
}

beforeEach(() => {
  for (const k of Object.keys(fx.tables)) delete fx.tables[k]
})

describe("sniper-feed computeSniperFeed (Supabase-driven TS pool)", () => {
  it("runs the compute end-to-end and returns a structured feed for an empty pool", async () => {
    // No ts_listings -> compute still runs the sparse-augment RPC path (empty) +
    // enrichment, returning a well-formed empty feed rather than throwing.
    fx.tables = { ts_listings: { data: [] } }
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.deals)).toBe(true)
    expect(body.count).toBe(body.deals.length)
    expect(body.marketplaceAvailability).toEqual({ topshot: true, flowty: false })
  })

  it("runs the compute body end-to-end over a populated pool without throwing", async () => {
    // >=25 listings skips the sparse-augment RPC and drives the GQL(=ts_listings)
    // pool through fetchTopShotPool's mapping, resolveEditionKeys, the FMV/badge/
    // jersey enrichment fan-out, the deal-build loop, and sort/filter. Deals filter
    // out here (empty fmv_current -> no priced FMV), but the whole compute BODY
    // executes and returns a valid structured feed rather than a 500.
    fx.tables = {
      ts_listings: {
        data: Array.from({ length: 30 }, (_, i) =>
          tsListing({ listing_id: `L${i}`, flow_id: `F${i}`, price_usd: 10 + i, player_name: `Player ${i}` }),
        ),
      },
    }
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.deals)).toBe(true)
    expect(body.count).toBe(body.deals.length)
  })

  it("honors the limit param against the computed deal set", async () => {
    fx.tables = {
      ts_listings: {
        data: Array.from({ length: 30 }, (_, i) => tsListing({ listing_id: `L${i}`, flow_id: `F${i}` })),
      },
    }
    const res = await GET(get("?collection=nba-top-shot&limit=3"))
    const body = await res.json()
    expect(body.deals.length).toBeLessThanOrEqual(3)
  })
})

// ---------------------------------------------------------------------------
// Enrichment fan-out: the prior cases left every lookup table EMPTY, so
// fetchFmvBatch / fetchBadgesByPlayers / fetchJerseyNumbers /
// attachSerialFmvEstimates all early-returned and their bodies stayed dark.
// These fixtures supply the real join shape (editions -> fmv_current keyed by
// uuid, badge_editions by player_name, players by jersey) so a deal actually
// survives the FMV filter and the enrichment writes land on it.
// ---------------------------------------------------------------------------

function enrichedTables(over: Record<string, any> = {}) {
  // 25+ listings skips the sparse-augment RPC path; all share edition 1:2 so a
  // single editions/fmv fixture prices the whole pool.
  const listings = Array.from({ length: 26 }, (_, i) =>
    tsListing({
      listing_id: `L${i}`,
      flow_id: `F${i}`,
      // serial 1 on the first listing triggers attachSerialFmvEstimates
      serial_number: i === 0 ? 1 : i + 10,
      price_usd: 10 + i,
    }),
  )
  return {
    ts_listings: { data: listings },
    editions: {
      data: [
        {
          id: "uuid-1-2",
          external_id: "1:2",
          set_id_onchain: 1,
          play_id_onchain: 2,
          thumbnail_url: "https://img/1-2.png",
        },
      ],
    },
    fmv_current: {
      data: [
        {
          edition_id: "uuid-1-2",
          fmv_usd: 100,
          wap_usd: 95,
          floor_price_usd: 80,
          confidence: "HIGH",
          days_since_sale: 2,
          sales_count_30d: 14,
          computed_at: "2026-07-16T00:00:00Z",
        },
        // a second, older snapshot for the same edition — the first-seen wins
        {
          edition_id: "uuid-1-2",
          fmv_usd: 1,
          wap_usd: 1,
          floor_price_usd: 1,
          confidence: "LOW",
          days_since_sale: 90,
          sales_count_30d: 0,
          computed_at: "2026-01-01T00:00:00Z",
        },
      ],
    },
    badge_editions: {
      data: [
        { player_name: "Stephen Curry", play_tags: ["3-pointer"], set_play_tags: ["rookie-mint"] },
        { player_name: "Someone Else", play_tags: null, set_play_tags: null },
      ],
    },
    players: { data: [{ name: "Stephen Curry", jersey_number: 30 }] },
    pack_ev_cache: { data: [] },
    // resolveEditionKeys maps (player|set|series) -> external_id via this RPC,
    // parsing "Player \u2014 Set" out of edition.name. Without it every listing
    // stays keyless and the whole pool filters out unpriced.
    "rpc:get_editions_for_sniper": {
      data: [{ name: "Stephen Curry \u2014 Base Set", series: 4, external_id: "1:2" }],
    },
    "rpc:serial_fmv_estimate": {
      data: { estimate_usd: 250, multiplier: 2.5, serial_bucket: "first_mint", label: "#1 premium" },
    },
    ...over,
  }
}

describe("sniper-feed enrichment fan-out (populated lookups)", () => {
  it("prices deals from fmv_current and attaches badges + jersey numbers", async () => {
    fx.tables = enrichedTables()
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body.deals.length).toBeGreaterThan(0)
    const d = body.deals[0]
    // edition resolution + the editions/fmv_current join actually landed
    expect(d.editionKey).toBe("1:2")
    expect(d.confidenceSource).toBe("supabase")
    // FMV came from the NEWEST snapshot (asp 95), not the stale one (asp 1)
    expect(d.aspUsd).toBe(95)
    expect(d.salesCount30d).toBe(14)
    // editions.thumbnail_url is preferred over the constructed asset URL
    expect(d.thumbnailUrl).toBe("https://img/1-2.png")
    // badge + serial enrichment shape is present
    expect(Array.isArray(d.badgeSlugs)).toBe(true)
    expect(typeof d.isJersey).toBe("boolean")
  })

  it("survives a badge_editions read error (badges degrade, deals still price)", async () => {
    fx.tables = enrichedTables({
      badge_editions: { data: null, error: { message: "badges down" } },
    })
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals.length).toBeGreaterThan(0)
    expect(body.deals[0].aspUsd).toBe(95)
    expect(body.deals[0].badgeSlugs).toEqual([])
  })

  it("survives a players read error (jersey lookup degrades)", async () => {
    fx.tables = enrichedTables({
      players: { data: null, error: { message: "players down" } },
    })
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals.length).toBeGreaterThan(0)
  })

  it("returns an unpriced feed when editions resolve but no FMV snapshot exists", async () => {
    fx.tables = enrichedTables({ fmv_current: { data: [] } })
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json()).deals)).toBe(true)
  })

  it("returns an unpriced feed when the editions lookup misses entirely", async () => {
    fx.tables = enrichedTables({ editions: { data: [] } })
    const res = await GET(get("?collection=nba-top-shot"))
    expect(res.status).toBe(200)
    expect(Array.isArray((await res.json()).deals)).toBe(true)
  })

  it("honours ?limit= and still returns a well-formed feed", async () => {
    fx.tables = enrichedTables()
    const body = await (await GET(get("?collection=nba-top-shot&limit=3"))).json()
    expect(body.deals.length).toBeLessThanOrEqual(3)
    expect(body.count).toBe(body.deals.length)
  })

  // ── NULL-FMV honesty (2026-07-25) ───────────────────────────────────────
  // The ask-proxy fallback guards on `baseFmv < 1`, and in JavaScript
  // `null < 1` is TRUE. So an edition whose fmv_usd is NULL fell into the
  // fallback and was repriced as floor_price_usd * 0.90 — a fabricated fair
  // value for an edition that has none. A missing FMV must drop the row.
  it("NULL fmv_usd → row EXCLUDED, never repriced off the floor ask (ask_proxy)", async () => {
    fx.tables = enrichedTables({
      fmv_current: {
        data: [
          {
            edition_id: "uuid-1-2",
            fmv_usd: null, // <- absent, not small
            wap_usd: 95,
            floor_price_usd: 80, // old code: baseFmv = 80 * 0.90 = 72
            confidence: "LOW",
            days_since_sale: 90,
            sales_count_30d: 0,
            computed_at: "2026-07-16T00:00:00Z",
          },
        ],
      },
    })
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals.length).toBe(0)
    expect(body.deals.some((d: any) => d.confidenceSource === "ask_proxy")).toBe(false)
    expect(body.deals.some((d: any) => d.baseFmv === 72)).toBe(false)
    expect(body.deals.some((d: any) => d.baseFmv === 0)).toBe(false)
  })

  // Guard against over-correcting: a REAL near-zero FMV with LOW confidence is
  // still allowed to use the documented ask-proxy signal. Only NULL drops.
  it("a real near-zero fmv_usd still takes the documented ask_proxy path", async () => {
    fx.tables = enrichedTables({
      fmv_current: {
        data: [
          {
            edition_id: "uuid-1-2",
            fmv_usd: 0.5,
            wap_usd: 95,
            floor_price_usd: 80,
            confidence: "LOW",
            days_since_sale: 90,
            sales_count_30d: 0,
            computed_at: "2026-07-16T00:00:00Z",
          },
        ],
      },
    })
    const body = await (await GET(get("?collection=nba-top-shot"))).json()
    expect(body.deals.length).toBeGreaterThan(0)
    expect(body.deals[0].confidenceSource).toBe("ask_proxy")
  })
})
