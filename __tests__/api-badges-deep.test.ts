import { describe, it, expect, beforeEach, vi } from "vitest"
import { NextRequest } from "next/server"

// GET /api/badges — the badge_editions browser. Two things here are worth
// pinning, and neither shows up as an error when it breaks:
//
//   1. The PLAY-TAG ALLOWLIST. Top Shot's play_tags mix ~6 real badges with ~25
//      gameplay descriptors (Jump Shot, Dunk, Block, Steal…). Only the allowlist
//      titles are badges; set_play_tags are all real and stay unfiltered. Drop
//      the filter and every moment sprouts fake "badges" — the exact fabricated-
//      signal class the repo treats as a P0. This mirrors the Postgres side
//      (get_edition_badges_unified / audit_20260524_badge_unified_filter_play_tags).
//   2. The MODE → FILTER map. Thirteen modes each translate to a specific tag
//      UUID / column equality, applied to BOTH the count and data queries. A
//      mode that silently falls through to "no filter" returns the whole table
//      under a badge heading — plausible-looking and entirely wrong.
//
// The mock records what was applied to each query so both can be asserted.

interface Recorded {
  eq: Array<[string, unknown]>
  contains: Array<[string, unknown]>
  ilike: Array<[string, unknown]>
  like: Array<[string, unknown]>
  not: Array<unknown[]>
  or: string[]
  order: Array<[string, unknown]>
  range: Array<[number, number]>
}

const state = vi.hoisted(() => ({
  rows: [] as unknown[],
  count: 0,
  error: null as unknown,
  syncRow: { updated_at: "2026-07-20T00:00:00Z" } as unknown,
  /** One Recorded per builder created (count query, data query, sync query). */
  builders: [] as Recorded[],
}))

vi.mock("@supabase/supabase-js", () => {
  const makeBuilder = () => {
    const rec: Recorded = { eq: [], contains: [], ilike: [], like: [], not: [], or: [], order: [], range: [] }
    state.builders.push(rec)
    let head = false
    let isSingle = false
    const b: unknown = new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "then") {
            return (resolve: (v: unknown) => unknown) => {
              if (isSingle) return resolve({ data: state.syncRow, error: null })
              if (state.error) return resolve({ data: null, count: null, error: state.error })
              return resolve({ data: head ? null : state.rows, count: state.count, error: null })
            }
          }
          return (...args: unknown[]) => {
            const k = String(prop)
            if (k === "select" && (args[1] as { head?: boolean } | undefined)?.head) head = true
            if (k === "single") { isSingle = true; return b }
            if (k in rec) (rec as unknown as Record<string, unknown[]>)[k].push(args.length > 1 ? args : args[0])
            return b
          }
        },
      },
    )
    return b
  }
  return { createClient: () => ({ from: () => makeBuilder() }) }
})

import { GET } from "@/app/api/badges/route"

const req = (qs = "") => new NextRequest("https://t/api/badges" + qs)

/** The count query is built first, the data query second. */
const countQ = () => state.builders[0]
const dataQ = () => state.builders[1]

beforeEach(() => {
  state.rows = []
  state.count = 0
  state.error = null
  state.syncRow = { updated_at: "2026-07-20T00:00:00Z" }
  state.builders = []
})

describe("GET /api/badges — the play-tag allowlist", () => {
  it("keeps real badge play_tags, drops gameplay descriptors, and never filters set_play_tags", async () => {
    state.rows = [
      {
        play_tags: [
          { id: "p1", title: "Top Shot Debut" }, // allowlisted (normalizes to topshotdebut)
          { id: "p2", title: "Rookie Year" }, // allowlisted
          { id: "p3", title: "Jump Shot" }, // gameplay descriptor — NOT a badge
          { id: "p4", title: "Block" }, // gameplay descriptor
          { id: "p5", title: 42 }, // non-string — defensively dropped
        ],
        set_play_tags: [{ id: "s1", title: "Anything At All" }], // never filtered
        parallel_id: 0,
        low_ask: 12,
        highest_offer: 9,
        tier: "MOMENT_TIER_RARE",
      },
    ]

    const body = await (await GET(req("?mode=all"))).json()
    const ed = body.editions[0]

    expect(ed.badge_titles).toEqual(["Top Shot Debut", "Rookie Year", "Anything At All"])
    expect(ed.badges.filter((b: { source: string }) => b.source === "play")).toHaveLength(2)
    expect(ed.badges.find((b: { id: string }) => b.id === "s1").source).toBe("set_play")
  })

  it("normalizes punctuation and case before matching the allowlist", async () => {
    state.rows = [
      { play_tags: [{ id: "a", title: "ROOKIE_OF_THE_YEAR" }, { id: "b", title: "all-star" }], set_play_tags: [] },
    ]
    const body = await (await GET(req("?mode=all"))).json()
    expect(body.editions[0].badge_titles).toEqual(["ROOKIE_OF_THE_YEAR", "all-star"])
  })

  it("tolerates rows with no tag arrays at all", async () => {
    state.rows = [{ parallel_id: 0 }]
    const body = await (await GET(req("?mode=all"))).json()
    expect(body.editions[0].badges).toEqual([])
    expect(body.editions[0].badge_titles).toEqual([])
  })
})

describe("GET /api/badges — derived row fields", () => {
  it("maps known parallels by name and falls back to 'Parallel N' for the rest", async () => {
    state.rows = [
      { parallel_id: 0 }, { parallel_id: 17 }, { parallel_id: 19 }, { parallel_id: 99 },
    ]
    const body = await (await GET(req("?mode=all"))).json()
    expect(body.editions.map((e: { parallel_display: string }) => e.parallel_display)).toEqual([
      "Standard", "Blockchain", "Hexwave", "Parallel 99",
    ])
    expect(body.editions[0].is_standard).toBe(true)
    expect(body.editions[1].is_standard).toBe(false)
  })

  it("computes price_gap only when BOTH sides are present", async () => {
    state.rows = [
      { parallel_id: 0, low_ask: 20, highest_offer: 8 },
      { parallel_id: 0, low_ask: 20, highest_offer: null },
      { parallel_id: 0, low_ask: null, highest_offer: 8 },
    ]
    const body = await (await GET(req("?mode=all"))).json()
    expect(body.editions.map((e: { price_gap: number | null }) => e.price_gap)).toEqual([12, null, null])
  })

  it("strips the MOMENT_TIER_ prefix and title-cases the tier, tolerating a null", async () => {
    state.rows = [{ parallel_id: 0, tier: "MOMENT_TIER_LEGENDARY" }, { parallel_id: 0, tier: null }]
    const body = await (await GET(req("?mode=all"))).json()
    expect(body.editions[0].tier_display).toBe("LEGENDARY")
    expect(body.editions[1].tier_display).toBe("")
  })
})

describe("GET /api/badges — the mode → filter map", () => {
  const cases: Array<[string, (r: Recorded) => void]> = [
    ["threestar", (r) => {
      expect(r.eq).toContainEqual(["is_three_star_rookie", true])
      expect(r.eq).toContainEqual(["has_rookie_mint", true])
    }],
    ["rookieyear", (r) => expect(String(r.contains[0]?.[1])).toContain("2dbd4eef")],
    ["debut", (r) => expect(String(r.contains[0]?.[1])).toContain("a75e247a")],
    ["rookiemint", (r) => expect(r.contains[0]?.[0]).toBe("set_play_tags")],
    ["roty", (r) => expect(String(r.contains[0]?.[1])).toContain("34fe8d3f")],
    ["championship", (r) => expect(String(r.contains[0]?.[1])).toContain("f197f60a")],
    ["blazers", (r) => expect(r.eq).toContainEqual(["team_nba_id", "1610612757"])],
    ["rookie_ad", (r) => expect(String(r.contains[0]?.[1])).toContain('"Rookie"')],
    ["superbowl_ad", (r) => expect(String(r.contains[0]?.[1])).toContain("Super Bowl")],
    ["playoffs_ad", (r) => expect(String(r.contains[0]?.[1])).toContain("Playoffs")],
    ["probowl_ad", (r) => expect(String(r.contains[0]?.[1])).toContain("Pro Bowl")],
    ["firsttd_ad", (r) => expect(String(r.contains[0]?.[1])).toContain("First Touchdown")],
  ]

  for (const [mode, assert] of cases) {
    it(`${mode} applies its filter to BOTH the count and data queries`, async () => {
      await GET(req(`?mode=${mode}`))
      assert(countQ())
      assert(dataQ())
    })
  }

  it("an unknown mode applies no tag filter — only the collection scope", async () => {
    await GET(req("?mode=not-a-mode"))
    expect(countQ().contains).toHaveLength(0)
    // The collection scope is still applied on every mode.
    expect(countQ().eq).toContainEqual(["collection_id", "95f28a17-224a-4025-96ad-adf8a4c63bfd"])
  })

  it("honours an explicit collection_id", async () => {
    await GET(req("?mode=all&collection_id=dee28451-5d62-409e-a1ad-a83f763ac070"))
    expect(dataQ().eq).toContainEqual(["collection_id", "dee28451-5d62-409e-a1ad-a83f763ac070"])
  })
})

describe("GET /api/badges — query params", () => {
  it("applies season, team, and a single player (case-insensitive)", async () => {
    await GET(req("?mode=all&season=2024-25&team=1610612757&player=damian%20lillard"))
    expect(dataQ().eq).toContainEqual(["season", "2024-25"])
    expect(dataQ().eq).toContainEqual(["team_nba_id", "1610612757"])
    expect(dataQ().ilike).toContainEqual(["player_name", "damian lillard"])
  })

  it("applies a numeric parallel but ignores a non-numeric one", async () => {
    await GET(req("?mode=all&parallel=17"))
    expect(dataQ().eq).toContainEqual(["parallel_id", 17])

    state.builders = []
    await GET(req("?mode=all&parallel=hexwave"))
    expect(dataQ().eq.find(([c]) => c === "parallel_id")).toBeUndefined()
  })

  it("splits the NBA/WNBA leagues on the season format", async () => {
    await GET(req("?mode=all&league=NBA"))
    expect(dataQ().like).toContainEqual(["season", "____-__"])

    state.builders = []
    await GET(req("?mode=all&league=WNBA"))
    // WNBA is the negation of the NBA "YYYY-YY" shape.
    expect(dataQ().not[0]).toEqual(["season", "like", "____-__"])
  })

  it("builds an ilike OR filter for a players list, and single `player` wins over it", async () => {
    await GET(req("?mode=all&players=Dame%20Lillard,%20Anthony%20Edwards%20,"))
    // Blank segments are dropped and each name is trimmed.
    expect(dataQ().or[0]).toBe("player_name.ilike.Dame Lillard,player_name.ilike.Anthony Edwards")

    state.builders = []
    await GET(req("?mode=all&player=Dame&players=Someone%20Else"))
    expect(dataQ().or).toHaveLength(0)
    expect(dataQ().ilike).toContainEqual(["player_name", "Dame"])
  })

  it("falls back to badge_score for a sort column outside the allowlist", async () => {
    await GET(req("?mode=all&sort=low_ask&dir=asc"))
    expect(dataQ().order[0]).toEqual(["low_ask", { ascending: true }])

    state.builders = []
    // An arbitrary column would be a SQL-injection-shaped foot-gun; it must not
    // reach the query.
    const body = await (await GET(req("?mode=all&sort=player_name;drop"))).json()
    expect(dataQ().order[0]).toEqual(["badge_score", { ascending: false }])
    expect(body.meta.sort).toBe("badge_score")
  })

  it("clamps limit at 500 and passes offset through to the range window", async () => {
    await GET(req("?mode=all&limit=9999&offset=100"))
    expect(dataQ().range[0]).toEqual([100, 599])

    state.builders = []
    const body = await (await GET(req("?mode=all&limit=10&offset=5"))).json()
    expect(dataQ().range[0]).toEqual([5, 14])
    expect(body.meta).toMatchObject({ limit: 10, offset: 5 })
  })
})

describe("GET /api/badges — meta + failure", () => {
  it("reports the total, the echoed filters, and the last sync stamp", async () => {
    state.count = 137
    const body = await (await GET(req("?mode=blazers&season=2024-25&parallel=17"))).json()
    expect(body.meta).toMatchObject({
      total: 137, mode: "blazers", season: "2024-25", parallel: "17", dir: "desc",
      lastSync: "2026-07-20T00:00:00Z",
    })
  })

  it("echoes 'all' for absent season/parallel and tolerates a missing sync row", async () => {
    state.syncRow = null
    const body = await (await GET(req("?mode=all"))).json()
    expect(body.meta).toMatchObject({ season: "all", parallel: "all", lastSync: null })
  })

  it("500s with the message when the data query errors", async () => {
    state.error = new Error("badge_editions unavailable")
    const res = await GET(req("?mode=all"))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe("badge_editions unavailable")
  })
})
