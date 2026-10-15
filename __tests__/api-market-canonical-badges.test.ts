import { describe, it, expect, beforeEach, vi } from "vitest"
import { makeSupabaseFixture } from "./helpers/route-harness"

// GET /api/market — Top Shot and All Day badges come from the canonical
// get_edition_badge_titles, and ?badges= / ?hasBadges= filter the modern path.
//
// R104 (2026-10-13): both previous sources were the always-empty
// `editions.badges` column, so production showed 0 badges where the canonical
// source had 44 of 100 All Day and 2 of 47 Top Shot editions badged, and the
// modern path ignored the badge filter entirely. These tests assert the ABSENCE
// of both false answers: an empty badge cell over a badged edition, and a list
// that claims to be badge-filtered but is not.

const state = vi.hoisted(() => ({ sb: null as unknown }))
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: new Proxy({}, { get: (_t, prop) => (state.sb as Record<PropertyKey, unknown>)[prop] }),
}))

import { GET } from "@/app/api/market/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALLDAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const req = (u: string) => ({ nextUrl: new URL(u) }) as never
const install = (f: Record<string, unknown>) => {
  state.sb = makeSupabaseFixture(f as never)
}
beforeEach(() => {
  state.sb = null
})

// Three All Day editions; the RPC's own `badges` is EMPTY, as it is in
// production (it reads editions.badges).
const alldayRows = {
  "rpc:get_allday_market_editions_v3": {
    data: [
      { external_id: "a", player_name: "A", set_name: "Rookie Debut", floor_ask: 1, fmv_usd: 2, tier: "COMMON", listed_count: 1, circulation_count: 10, badges: [], last_listed_at: "2026-10-03T00:00:00Z" },
      { external_id: "b", player_name: "B", set_name: "Base", floor_ask: 1, fmv_usd: 2, tier: "COMMON", listed_count: 1, circulation_count: 10, badges: [], last_listed_at: "2026-10-02T00:00:00Z" },
      { external_id: "c", player_name: "C", set_name: "Playoff", floor_ask: 1, fmv_usd: 2, tier: "COMMON", listed_count: 1, circulation_count: 10, badges: [], last_listed_at: "2026-10-01T00:00:00Z" },
    ],
    error: null,
  },
  editions: { data: [], error: null },
}
const canonical = {
  "rpc:get_edition_badge_titles": {
    data: { a: ["Rookie Year", "ALL DAY Debut"], b: [], c: ["Championship Year"] },
    error: null,
  },
}
const failedCanonical = {
  "rpc:get_edition_badge_titles": { data: null, error: { message: "canceling statement due to statement timeout" } },
}
type Body = { listings: Array<{ editionKey: string; badgeSlugs: string[] }>; diagnostics: Record<string, unknown>; pagination: { total: number } }
const byKey = (b: Body) => Object.fromEntries(b.listings.map((r) => [r.editionKey, r.badgeSlugs]))

describe("GET /api/market — canonical badges (R104)", () => {
  it("All Day rows carry the CANONICAL titles, not the RPC's empty editions.badges", async () => {
    install({ ...alldayRows, ...canonical })
    const res = await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Body
    expect(byKey(body)).toEqual({ a: ["Rookie Year", "ALL DAY Debut"], b: [], c: ["Championship Year"] })
    expect(body.diagnostics.badgesUnavailable).toBeUndefined()
  })

  it("Top Shot rows (mapped with badge_slugs: null) carry canonical titles keyed by set:play", async () => {
    install({
      "rpc:get_topshot_sniper_deals_v3": {
        data: [{ moment_id: "39:1269", ask_price: 4, fmv_usd: 5, tier: "COMMON", circulation_count: 100, player_name: "Dame", set_name: "Base Set" }],
        error: null,
      },
      editions: {
        data: [{ external_id: "39:1269", collection_id: TS, player_name: "Dame", set_name: "Base Set", set_id_onchain: 39, play_id_onchain: 1269, badges: [] }],
        error: null,
      },
      "rpc:get_edition_badge_titles": { data: { "39:1269": ["Championship Year"] }, error: null },
    })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${TS}`))).json()) as Body
    expect(body.listings[0].editionKey).toBe("39:1269")
    expect(body.listings[0].badgeSlugs).toEqual(["Championship Year"])
  })

  // 2026-10-14: a PARALLEL edition ("257:8869::17") was looked up by its set:play
  // form, which names no edition row when there is no base edition — so it
  // rendered badgeless and the badge filter dropped it (58 of 500 Three-Star
  // Rookie rows on production).
  it("a Top Shot parallel edition is badge-read by its exact key, not the set:play wallet key", async () => {
    install({
      "rpc:get_topshot_sniper_deals_v3": {
        data: [{ moment_id: "257:8869::17", ask_price: 4, fmv_usd: 5, tier: "COMMON", circulation_count: 100, player_name: "Antonia Delaere", set_name: "WNBA Rookie Debut" }],
        error: null,
      },
      editions: {
        data: [{ external_id: "257:8869::17", collection_id: TS, player_name: "Antonia Delaere", set_name: "WNBA Rookie Debut", set_id_onchain: 257, play_id_onchain: 8869, badges: [] }],
        error: null,
      },
      "rpc:get_edition_badge_titles": { data: { "257:8869::17": ["Three-Star Rookie"] }, error: null },
    })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${TS}&badges=Three-Star%20Rookie`))).json()) as Body
    expect(body.listings).toHaveLength(1)
    expect(body.listings[0].badgeSlugs).toEqual(["Three-Star Rookie"])
    expect(body.listings[0].editionKey).toBe("257:8869")
  })

  it("?badges= filters the modern list (it used to be ignored — the chip showed active over an unfiltered list)", async () => {
    install({ ...alldayRows, ...canonical })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&badges=Championship%20Year`))).json()) as Body
    expect(body.listings.map((r) => r.editionKey)).toEqual(["c"])
    expect(body.pagination.total).toBe(1)
  })

  it("?badges= with several values keeps rows carrying ANY of them", async () => {
    install({ ...alldayRows, ...canonical })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&badges=Rookie%20Year,Championship%20Year`))).json()) as Body
    expect(body.listings.map((r) => r.editionKey).sort()).toEqual(["a", "c"])
  })

  it("?hasBadges=true keeps only badged rows", async () => {
    install({ ...alldayRows, ...canonical })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&hasBadges=true`))).json()) as Body
    expect(body.listings.map((r) => r.editionKey).sort()).toEqual(["a", "c"])
  })

  it("a FAILED badge read under a badge filter is a 503, never an empty or unfiltered list", async () => {
    install({ ...alldayRows, ...failedCanonical })
    const res = await GET(req(`https://t/api/market?collectionId=${ALLDAY}&badges=Rookie%20Year`))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.listings).toBeUndefined()
    expect(body.error).toBe("market_unavailable")
    expect(res.headers.get("Cache-Control")).toBe("no-store")
  })

  it("a FAILED badge read WITHOUT a badge filter still serves the listings, and says badges are unavailable", async () => {
    install({ ...alldayRows, ...failedCanonical })
    const res = await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))
    expect(res.status).toBe(200)
    const body = (await res.json()) as Body
    expect(body.listings).toHaveLength(3)
    expect(body.diagnostics.badgesUnavailable).toBe(true)
  })
})

// 2026-10-14: the Market dropdowns were built from the 50 rows on the page. The
// route now returns `facets` over its whole fetched window, before the badge /
// discount post-filters, so a badge carried only by a row beyond the page — or
// filtered out by the current badge pick — is still offered.
describe("GET /api/market — facets", () => {
  type FacetBody = { listings: unknown[]; facets: { sets: string[]; badges: string[]; players: string[] } }

  it("offers every badge and set in the window, including rows beyond the page", async () => {
    install({ ...alldayRows, ...canonical })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&limit=1`))).json()) as FacetBody
    expect(body.listings).toHaveLength(1)
    expect(body.facets.badges).toEqual(["ALL DAY Debut", "Championship Year", "Rookie Year"])
    expect(body.facets.sets).toEqual(["Base", "Playoff", "Rookie Debut"])
    expect(body.facets.players).toEqual(["A", "B", "C"])
  })

  it("keeps the other badges on offer while one badge is selected", async () => {
    install({ ...alldayRows, ...canonical })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&badges=Championship%20Year`))).json()) as FacetBody
    expect(body.listings).toHaveLength(1)
    expect(body.facets.badges).toContain("Rookie Year")
  })

  it("offers no badges when the badge read failed", async () => {
    install({ ...alldayRows, ...failedCanonical })
    const body = (await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))).json()) as FacetBody
    expect(body.facets.badges).toEqual([])
  })
})

// 2026-10-15: Owned / Not owned is applied by the RPC; the response says so, so
// the page does not re-filter its 50 rows with its set:play-keyed counts.
describe("GET /api/market — ownedApplied", () => {
  it("is true when the Top Shot / All Day RPC got the owned filter, false otherwise", async () => {
    install({ ...alldayRows, ...canonical })
    const on = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&owned=owned&wallet=0x1234567890abcdef`))).json()
    expect(on.ownedApplied).toBe(true)
    const noWallet = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}&owned=owned`))).json()
    expect(noWallet.ownedApplied).toBe(false)
    const off = await (await GET(req(`https://t/api/market?collectionId=${ALLDAY}`))).json()
    expect(off.ownedApplied).toBe(false)
  })
})
