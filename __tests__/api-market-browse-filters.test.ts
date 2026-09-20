import { describe, it, expect, vi, beforeEach } from "vitest"

/**
 * THE MARKET TAB'S Set / Series / Player / Min-price FILTERS on the arms that
 * can honour them — Pinnacle and Candy.
 *
 * ⓘ Named for the FILTERS, not for Pinnacle: the Top Shot and All Day arms are
 * RPCs and still drop these (register #129). When either gains filter
 * parameters, its arms belong in this file, not in a second one.
 *
 * 🚨 WHY THIS FILE EXISTS. Those four were parsed from the query string and then
 * applied ONLY inside the legacy `cached_listings` fall-through — a block no
 * modern arm ever reaches. So on Pinnacle (and Top Shot, All Day, Candy) the UI
 * rendered an ACTIVE filter chip and returned unfiltered rows.
 *
 * Measured on production 2026-09-20, before the fix:
 *   /api/market?collectionId=<pinnacle>&set=Pixar Animation Studios • Toy Story Vol.1
 *     → rows from Beauty and the Beast, Star Wars Alphabet, The Jungle Book,
 *       Cats & Dogs. Not one row from the requested set.
 *   /api/market?collectionId=<topshot>&set=Base Set
 *     → "WNBA Base Set", "Archive Set 2014-19".
 *
 * ⛔ THE FIX IS AT THE SOURCE, NOT IN MEMORY, and that distinction is the whole
 * point. The modern arms fetch a capped window (1,000 rows) ordered by the
 * active sort. Filtering that window after the fact would apply the filter to an
 * ALREADY-TRUNCATED set — turning "filter ignored" into a confident "no listings
 * in this set", which is strictly worse. The DB filter narrows first; the
 * in-memory pass below only makes the match EXACT.
 */

type Row = Record<string, any>
const calls: { filters: Record<string, any>; rows: Row[] } = { filters: {}, rows: [] }

vi.mock("@/lib/supabase", () => {
  const b: any = {
    select: () => b,
    not: () => b,
    gt: () => b,
    gte: (col: string, v: any) => { calls.filters[`gte:${col}`] = v; return b },
    lte: (col: string, v: any) => { calls.filters[`lte:${col}`] = v; return b },
    eq: () => b,
    in: (col: string, v: any) => { calls.filters[`in:${col}`] = v; return b },
    ilike: (col: string, v: any) => { calls.filters[`ilike:${col}`] = v; return b },
    order: () => b,
    limit: () => b,
    then: (resolve: any) => resolve({ data: calls.rows, error: null, count: calls.rows.length }),
  }
  return { supabaseAdmin: { from: () => b } }
})

const PINNACLE = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

function cat(render_id: string, set_name: string, over: Row = {}): Row {
  return {
    render_id, set_name, character_name: "Buzz", series_name: "2023",
    variant: "Standard", total_minted: 100, floor_ask: 10, fmv_usd: 9,
    fmv_confidence: "MEDIUM", thumbnail_url: null,
    floor_ask_updated_at: new Date().toISOString(), ...over,
  }
}

const req = (qs: string) => ({ nextUrl: new URL(`https://t/api/market?collectionId=${PINNACLE}&${qs}`) }) as any

beforeEach(() => { calls.filters = {}; calls.rows = [] })

describe("/api/market — the modern arms honour the filters the UI shows as active", () => {
  it("pushes the set filter to the DB as a whitespace-tolerant pattern", async () => {
    const { GET } = await import("@/app/api/market/route")
    calls.rows = [cat("A", "Toy Story Vol.1")]
    await GET(req("set=Toy%20Story%20Vol.1"))
    // ⚠ NOT `.in("set_name", …)`: 22 of the 169 live names carry stray
    // leading/trailing whitespace while the row this API returns is trimmed, so
    // equality would match nothing and read as "no listings in this set".
    expect(calls.filters["ilike:set_name"]).toBe("%Toy Story Vol.1%")
    expect(calls.filters["in:set_name"]).toBeUndefined()
  })

  it("DROPS a substring over-match the DB pattern let through — the pattern narrows, it does not decide", async () => {
    const { GET } = await import("@/app/api/market/route")
    // "Vol.1" is a substring of "Vol.10"; the ilike returns both.
    calls.rows = [cat("A", "Toy Story Vol.1"), cat("B", "Toy Story Vol.10")]
    const res = await GET(req("set=Toy%20Story%20Vol.1"))
    const body = await res.json()
    const names = body.listings.map((l: any) => l.setName)
    expect(names).toContain("Toy Story Vol.1")
    expect(names).not.toContain("Toy Story Vol.10")
  })

  it("matches a set whose stored name carries stray whitespace", async () => {
    const { GET } = await import("@/app/api/market/route")
    calls.rows = [cat("A", " Star Wars Alphabet Vol.1"), cat("B", "Something Else")]
    const res = await GET(req("set=Star%20Wars%20Alphabet%20Vol.1"))
    const body = await res.json()
    expect(body.listings).toHaveLength(1)
    expect(body.listings[0].setName).toBe("Star Wars Alphabet Vol.1")
  })

  it("honours a multi-select of sets exactly", async () => {
    const { GET } = await import("@/app/api/market/route")
    calls.rows = [cat("A", "Set One"), cat("B", "Set Two "), cat("C", "Set Three")]
    const res = await GET(req("set=Set%20One,Set%20Two"))
    const body = await res.json()
    expect(body.listings.map((l: any) => l.setName).sort()).toEqual(["Set One", "Set Two"])
  })

  it("pushes series, character and min-price to the DB", async () => {
    const { GET } = await import("@/app/api/market/route")
    calls.rows = [cat("A", "Set One")]
    await GET(req("series=2024&player=Buzz&minPrice=5"))
    expect(calls.filters["in:series_name"]).toEqual(["2024"])
    expect(calls.filters["ilike:character_name"]).toBe("%Buzz%")
    expect(calls.filters["gte:floor_ask"]).toBe(5)
  })

  it("Candy gets the same treatment from the SAME helper, on its own column names", async () => {
    const { GET } = await import("@/app/api/market/route")
    const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"
    calls.rows = [
      { token_mint: "m1", edition_id: "e1", player_name: "Judge", set_name: "S1", ask_usd: 9, tier: "COMMON" },
      { token_mint: "m2", edition_id: "e2", player_name: "Soto", set_name: "S2", ask_usd: 9, tier: "COMMON" },
    ]
    const res = await GET({
      nextUrl: new URL(`https://t/api/market?collectionId=${CANDY}&set=S1&player=Judge&minPrice=5`),
    } as any)
    const body = await res.json()
    // ⚠ Candy's price column is `ask_usd` and its subject column is
    // `player_name` — different names, same helper. A second copy of this logic
    // is how the two would drift.
    expect(calls.filters["gte:ask_usd"]).toBe(5)
    expect(calls.filters["ilike:player_name"]).toBe("%Judge%")
    expect(calls.filters["ilike:set_name"]).toBe("%S1%")
    // …and the exact pass still decides, on Candy too.
    expect(body.listings.map((l: any) => l.setName)).toEqual(["S1"])
  })

  it("Candy is offered NO series filter — the board has no such column", async () => {
    const { GET } = await import("@/app/api/market/route")
    const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"
    calls.rows = [{ token_mint: "m1", edition_id: "e1", player_name: "Judge", set_name: "S1", ask_usd: 9, tier: "COMMON" }]
    await GET({ nextUrl: new URL(`https://t/api/market?collectionId=${CANDY}&series=2026`) } as any)
    // ⛔ Must not invent a column. Filtering a non-existent `series_name` would
    // error the read and render the whole market as empty.
    expect(calls.filters["in:series_name"]).toBeUndefined()
  })

  it("is a no-op when no filter is sent — the arm must not narrow by accident", async () => {
    const { GET } = await import("@/app/api/market/route")
    calls.rows = [cat("A", "Set One"), cat("B", "Set Two")]
    const res = await GET(req("limit=50"))
    const body = await res.json()
    expect(body.listings).toHaveLength(2)
    expect(calls.filters["ilike:set_name"]).toBeUndefined()
    expect(calls.filters["gte:floor_ask"]).toBeUndefined()
  })
})
