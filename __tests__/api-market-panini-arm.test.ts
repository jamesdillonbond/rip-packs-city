import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — the Panini arm (published 2026-09-25, Overview + Market).
// Reads `panini_market_board` (one row per bridged edition with an ask confirmed
// in the last 7 days). Pins: the buy link is Panini's own edition page, no Flow
// furniture, the listing-gated coverage rides the response, and a FAILED read
// never falls through to `cached_listings` (zero Panini rows) as "no listings".

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never
// The route reads the stored copy (`mv_panini_market_board`) first and the live view when the
// copy is unreadable or stale. Cases that only describe the live view get an UNPOPULATED copy,
// so they exercise the fallback; the stored-copy cases at the end supply their own.
const UNPOPULATED = { data: null, error: { message: 'materialized view "mv_panini_market_board" has not been populated' } }
const install = (f: Record<string, unknown>) => {
  state.sb = makeSupabaseFixture(({ mv_panini_market_board: UNPOPULATED, ...f }) as never)
}

const COVERAGE = {
  total_editions: 5094, pct_trustworthy: 35.2, listing_gated_editions: 3300, listing_gated_families: 40,
  families: 62, edition_age_p50_h: 22.5, edition_age_p90_h: 38.9, pct_editions_stale_45d: 0,
}

function board() {
  return {
    panini_market_board: {
      data: [
        { external_id: "packcard-2332_1_2_3", player_name: "Lionel Messi", set_name: "Base Prizms Gold", tier: "LEGENDARY", circulation_count: 10, thumbnail_url: "https://img/m.png", low_ask_usd: 400, listed_count: 3, ask_confirmed_at: "2026-09-25T20:00:00Z", fmv_usd: 500, confidence: "MEDIUM", discount_pct: 20 },
        { external_id: "packcard-2332_4_5_6", player_name: "Kylian Mbappe", set_name: "Base Prizms Silver", tier: "COMMON", circulation_count: 259, thumbnail_url: null, low_ask_usd: 5, listed_count: 12, ask_confirmed_at: "2026-09-25T21:00:00Z", fmv_usd: 4, confidence: "LOW", discount_pct: -25 },
      ],
      error: null,
    },
    panini_coverage_summary: { data: [COVERAGE], error: null },
    editions: { data: [], error: null },
  }
}

beforeEach(() => { state.sb = null })

describe("GET /api/market — Panini arm", () => {
  it("serves panini_market_board rows linking to Panini's own edition page, with no Flow furniture", async () => {
    install(board())
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toHaveLength(2)
    const messi = body.listings.find((l: any) => l.playerName === "Lionel Messi")
    expect(messi.buyUrl).toBe("https://nft.paniniamerica.net/marketplace-details/packcard-2332_1_2_3.html")
    expect(messi.editionKey).toBe("packcard-2332_1_2_3")
    expect(messi.listedCount).toBe(3)
    expect(messi.discount).toBe(20)
    expect(messi.flowId).toBeNull()
    expect(messi.teamName).toBeNull() // a nation is not a team
    expect(messi.source).toBe("panini")
    // An absolute URL is not a stored Panini path shape — refused, never passed
    // through to an arbitrary host (2026-09-27: relative paths now resolve on
    // Panini's measured asset host; see the relative-path case below).
    expect(messi.thumbnailUrl).toBeNull()
    expect(messi.lowConfidenceFmv).toBe(false) // MEDIUM anchors a discount
    const mbappe = body.listings.find((l: any) => l.playerName === "Kylian Mbappe")
    expect(mbappe.lowConfidenceFmv).toBe(true) // LOW does not
  })

  const lowRow = { external_id: "low", player_name: "A", set_name: "S", tier: "RARE", circulation_count: 49, thumbnail_url: "pack/x.png", low_ask_usd: 2, listed_count: 1, ask_confirmed_at: "2026-09-25T20:00:00Z", fmv_usd: 73, confidence: "LOW", discount_pct: 97 }
  const medRow = { external_id: "med", player_name: "B", set_name: "S", tier: "RARE", circulation_count: 49, thumbnail_url: null, low_ask_usd: 80, listed_count: 1, ask_confirmed_at: "2026-09-25T20:00:00Z", fmv_usd: 100, confidence: "MEDIUM", discount_pct: 20 }

  it("a LOW-confidence Panini discount sorts BELOW a real one in discount sort", async () => {
    // Discount sorts read two windows: non-LOW first, then LOW (2026-09-25).
    install({
      ...board(),
      panini_market_board: [{ data: [medRow], error: null }, { data: [lowRow], error: null }],
    })
    const body = await (await GET(req(`https://t/api/market?collectionId=${PANINI}&sort=discount_desc`))).json()
    expect(body.listings.map((l: any) => l.editionKey)).toEqual(["med", "low"])
  })

  it("a stored RELATIVE thumbnail resolves on Panini's measured asset host; a missing one stays null", async () => {
    install({
      ...board(),
      panini_market_board: [{ data: [medRow], error: null }, { data: [lowRow], error: null }],
    })
    const body = await (await GET(req(`https://t/api/market?collectionId=${PANINI}&sort=discount_desc`))).json()
    const byKey = Object.fromEntries(body.listings.map((l: any) => [l.editionKey, l]))
    expect(byKey.low.thumbnailUrl).toBe("https://assets.paniniamerica.net/catalog/product/pack/x.png")
    expect(byKey.med.thumbnailUrl).toBeNull()
  })

  it("discount sort reads the non-LOW window SEPARATELY, so LOW rows cannot crowd real deals out of it", async () => {
    const base = makeSupabaseFixture({
      ...board(),
      // Re-pinned 2026-11-19: the board is read from the stored copy; the two-window rule is
      // a property of the READ, so it is asserted on the source the route actually queries.
      mv_panini_market_board: [
        { data: [{ ...medRow, computed_at: new Date().toISOString() }], error: null },
        { data: [{ ...lowRow, computed_at: new Date().toISOString() }], error: null },
      ],
    } as never) as any
    const conf: Array<[string, unknown]> = []
    state.sb = {
      ...base,
      from: (t: string) => {
        const b = base.from(t)
        if (t !== "mv_panini_market_board") return b
        for (const m of ["eq", "neq"] as const) {
          const orig = b[m]
          b[m] = (...a: unknown[]) => {
            if (a[0] === "confidence") conf.push([m, a[1]])
            return orig(...a)
          }
        }
        return b
      },
    }
    await GET(req(`https://t/api/market?collectionId=${PANINI}&sort=discount_desc`))
    expect(conf).toEqual([["neq", "LOW"], ["eq", "LOW"]])
  })

  it("a failure of EITHER discount window is a failed read, never a half board", async () => {
    install({
      ...board(),
      panini_market_board: [{ data: [medRow], error: null }, { data: null, error: { message: "boom" } }],
    })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}&sort=discount_desc`))
    expect(res.status).toBeGreaterThanOrEqual(500)
  })

  it("carries the listing-gated coverage disclosure", async () => {
    install(board())
    const body = await (await GET(req(`https://t/api/market?collectionId=${PANINI}`))).json()
    expect(body.coverage.total_editions).toBe(5094)
    expect(body.coverage_failed).toBe(false)
  })

  it("a failed coverage read drops the FIGURES and says so — never a zero", async () => {
    install({ ...board(), panini_coverage_summary: { data: null, error: { message: "boom" } } })
    const body = await (await GET(req(`https://t/api/market?collectionId=${PANINI}`))).json()
    expect(body.coverage).toBeNull()
    expect(body.coverage_failed).toBe(true)
    expect(body.listings).toHaveLength(2)
  })

  it("⭐ 503s instead of falling through to cached_listings when the Panini read FAILS", async () => {
    install({
      panini_market_board: { data: null, error: { message: "canceling statement due to statement timeout" } },
      panini_coverage_summary: { data: [COVERAGE], error: null },
      // A fall-through would find this row and serve it as Panini's market.
      cached_listings: { data: [{ id: "flow-1", ask_price: 1, tier: "COMMON", collection_id: PANINI }], error: null, count: 1 },
      editions: { data: [], error: null },
    })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error).toBe("market_unavailable")
    expect(JSON.stringify(body)).not.toContain("flow-1")
  })

  it("a genuinely empty board is a 200 in the normal envelope, with coverage", async () => {
    install({ ...board(), panini_market_board: { data: [], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings).toEqual([])
    expect(body.pagination.total).toBe(0)
    expect(body.diagnostics.source).toBe("panini_market_board")
    expect(body.coverage.total_editions).toBe(5094)
  })

  it("a Panini board answers stale-while-revalidate for an hour; a failed read is never cached", async () => {
    install(board())
    const ok = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(ok.status).toBe(200)
    expect(ok.headers.get("Cache-Control")).toBe("public, s-maxage=300, stale-while-revalidate=3600")
    install({ ...board(), panini_market_board: { data: null, error: { message: "canceling statement due to statement timeout" } } })
    const failed = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(failed.status).toBe(503)
    expect(failed.headers.get("Cache-Control")).toBe("no-store")
  })

  const storedRow = (computedAt: string | null) => ({
    external_id: "stored-1", player_name: "Stored Copy", set_name: "S", tier: "RARE", circulation_count: 49, thumbnail_url: null,
    low_ask_usd: 10, listed_count: 1, ask_confirmed_at: "2026-11-19T00:00:00Z", fmv_usd: 20, confidence: "MEDIUM", discount_pct: 50,
    ...(computedAt === null ? {} : { computed_at: computedAt }),
  })
  const names = async (res: Response) => (await res.json()).listings.map((l: any) => l.playerName)

  it("answers from the stored copy when it is fresh, without reading the live view", async () => {
    const ops: string[] = []
    install({ ...board(), __ops: ops, mv_panini_market_board: { data: [storedRow(new Date(Date.now() - 10 * 60_000).toISOString())], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}`))
    expect(await names(res)).toEqual(["Stored Copy"])
    expect(ops).toContain("mv_panini_market_board:read")
    expect(ops).not.toContain("panini_market_board:read")
  })

  it("a stored copy older than 3 h is not answered from: the live view is read instead", async () => {
    install({ ...board(), mv_panini_market_board: { data: [storedRow(new Date(Date.now() - 4 * 3_600_000).toISOString())], error: null } })
    const got = await names(await GET(req(`https://t/api/market?collectionId=${PANINI}`)))
    expect(got).not.toContain("Stored Copy")
    expect(got).toContain("Lionel Messi")
  })

  it("stored rows with no computed_at are an unknown age, so the live view is read", async () => {
    install({ ...board(), mv_panini_market_board: { data: [storedRow(null)], error: null } })
    expect(await names(await GET(req(`https://t/api/market?collectionId=${PANINI}`)))).toContain("Lionel Messi")
  })

  it("an unreadable stored copy falls back to the live view; both failing is a 503, never an empty board", async () => {
    install(board()) // copy unpopulated, live ok
    expect(await names(await GET(req(`https://t/api/market?collectionId=${PANINI}`)))).toContain("Lionel Messi")
    install({ ...board(), panini_market_board: { data: null, error: { message: "boom" } } })
    expect((await GET(req(`https://t/api/market?collectionId=${PANINI}`))).status).toBe(503)
  })

  it("no-change control: Candy's arm still carries no coverage field", async () => {
    install({ candy_market_board: { data: [], error: null }, editions: { data: [], error: null } })
    const body = await (await GET(req(`https://t/api/market?collectionId=209ade70-32c5-4470-bc7c-4793d660f713`))).json()
    expect(body).not.toHaveProperty("coverage")
    expect(body.diagnostics.source).toBe("candy_market_board")
  })
})

// 2026-11-26: the league / brand scope (?property=<slug>). The slug resolves to Panini set ids
// (panini_property_set_ids); the board is narrowed at the source and the exact set id re-checked on the rows.
describe("GET /api/market — Panini league / brand scope", () => {
  const rows = () => ({
    ...board(),
    panini_market_board: {
      data: [
        { external_id: "packcard-2332_1_2_3", player_name: "Lionel Messi", set_name: "Base", tier: "RARE", circulation_count: 10, thumbnail_url: null, low_ask_usd: 400, listed_count: 3, ask_confirmed_at: "2026-09-25T20:00:00Z", fmv_usd: 500, confidence: "MEDIUM", discount_pct: 20 },
        // LIKE's `_` is a wildcard, so a longer set id sharing the prefix can come back; it must not be shown.
        { external_id: "packcard-23329_1_2_3", player_name: "Not World Cup", set_name: "Base", tier: "RARE", circulation_count: 10, thumbnail_url: null, low_ask_usd: 5, listed_count: 1, ask_confirmed_at: "2026-09-25T20:00:00Z", fmv_usd: 6, confidence: "MEDIUM", discount_pct: 10 },
      ],
      error: null,
    },
  })
  it("keeps only rows whose set id is in the league", async () => {
    install({ ...rows(), "rpc:panini_property_set_ids": { data: [2332], error: null } })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}&property=fifa-world-cup`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings.map((l: { playerName: string }) => l.playerName)).toEqual(["Lionel Messi"])
  })
  it("an unknown or malformed league is a 400, never the whole board under its name", async () => {
    install({ ...rows(), "rpc:panini_property_set_ids": { data: [], error: null } })
    const unknown = await GET(req(`https://t/api/market?collectionId=${PANINI}&property=no-such-league`))
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).not.toHaveProperty("listings")
    const malformed = await GET(req(`https://t/api/market?collectionId=${PANINI}&property=${encodeURIComponent("nba;drop")}`))
    expect(malformed.status).toBe(400)
  })
  it("a failed lookup is an error, never an unscoped board", async () => {
    install({ ...rows(), "rpc:panini_property_set_ids": { data: null, error: { message: "boom", code: "57014" } } })
    const res = await GET(req(`https://t/api/market?collectionId=${PANINI}&property=nba`))
    expect(res.status).toBe(503)
    expect(await res.json()).not.toHaveProperty("listings")
  })
})

// 2026-11-26: Candy has the same scope. The slug must be one of Candy's publisher_properties rows; the board
// is then read through candy_market_board_for_property (the view's own rows for that brand).
describe("GET /api/market — Candy league / brand scope", () => {
  const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"
  const now = new Date().toISOString()
  const row = (name: string, ext: string) => ({ token_mint: `mint-${ext}`, edition_id: `ed-${ext}`, external_id: ext, player_name: null, edition_name: name, set_name: name, team_name: null, tier: "RARE", circulation_count: 50, thumbnail_url: null, serial_number: 3, ask_usd: 20, fmv_usd: 25, confidence: "MEDIUM", discount_pct: 20, seller: "S", first_seen_at: now, last_seen_at: now, venue: "magic_eden", venue_url: null })
  const base = () => ({
    candy_listings: { data: [{ last_seen_at: now }], error: null },
    candy_market_board: { data: [row("Aaron Judge", "aaron-judge")], error: null },
    candy_listing_floor: { data: [], error: null },
    editions: { data: [], error: null },
  })
  it("reads the brand's own rows, not the whole board", async () => {
    install({ ...base(), publisher_properties: { data: [{ slug: "dc" }], error: null }, candy_scoped: { data: [row("Batman (1940-2011) #1", "batman-1")], error: null } })
    // PostgREST filters an RPC's rows like a table's; the harness's rpc() is a bare promise, so the scoped
    // read is served by a chainable table fixture and the call (name + slug) is recorded here.
    const sb = state.sb as { from: (t: string) => unknown; rpc: (n: string, a?: Record<string, unknown>) => unknown }
    const calls: Array<[string, unknown]> = []
    const rpc = sb.rpc.bind(sb)
    sb.rpc = (n, a) => { calls.push([n, a]); return n === "candy_market_board_for_property" ? sb.from("candy_scoped") : rpc(n, a) }
    const res = await GET(req(`https://t/api/market?collectionId=${CANDY}&property=dc`))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.listings.map((l: { editionKey: string }) => l.editionKey)).toEqual(["batman-1"])
    expect(calls).toContainEqual(["candy_market_board_for_property", { p_slug: "dc" }])
  })
  it("without the parameter it is the whole board", async () => {
    install(base())
    const body = await (await GET(req(`https://t/api/market?collectionId=${CANDY}`))).json()
    expect(body.listings.map((l: { editionKey: string }) => l.editionKey)).toEqual(["aaron-judge"])
  })
  it("an unknown brand is a 400 and a failed lookup a 503 — never the whole board under its name", async () => {
    install({ ...base(), publisher_properties: { data: [], error: null } })
    const unknown = await GET(req(`https://t/api/market?collectionId=${CANDY}&property=nba`))
    expect(unknown.status).toBe(400)
    expect(await unknown.json()).not.toHaveProperty("listings")
    install({ ...base(), publisher_properties: { data: null, error: { message: "boom", code: "57014" } } })
    const failed = await GET(req(`https://t/api/market?collectionId=${CANDY}&property=dc`))
    expect(failed.status).toBe(503)
    expect(await failed.json()).not.toHaveProperty("listings")
  })
})
