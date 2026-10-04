// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The entity-page market-cap tile. Pins the three states a reader can see —
// a failed read says so (never a number), a missing row renders NOTHING, and an
// unknown cap reads "Unknown" with its minted-supply bound (never $0) — plus the
// rank / 7-day figures and the exact RPC arguments the page sends.

const state: { calls: Array<{ fn: string; args: any }>; data: any; error: any; byFn: Record<string, { data: any; error: any }>; table: { data: any; error: any } } =
  { calls: [], data: [], error: null, byFn: {}, table: { data: [], error: null } }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      state.calls.push({ fn, args })
      if (state.byFn[fn]) return state.byFn[fn]
      return { data: state.error ? null : state.data, error: state.error }
    },
    from: (table: string) => {
      const q: any = { filters: [] as string[] }
      q.select = () => q
      q.eq = (c: string, v: unknown) => (q.filters.push(`${c}=${v}`), q)
      q.limit = (n: number) => {
        state.calls.push({ fn: `from:${table}`, args: { filters: q.filters, limit: n } })
        return Promise.resolve(state.table)
      }
      return q
    },
  },
}))

import MarketCapTile, { CollectionMarketCapTile, MarketCapTileBody } from "@/components/entity/MarketCapTile"
import { sevenDayChange, staleSince, type MarketCapEntityRow } from "@/lib/insights/market-cap-board"

afterEach(cleanup)
beforeEach(() => {
  state.calls = []
  state.data = []
  state.error = null
  state.byFn = {}
  state.table = { data: [], error: null }
})

const ROW: MarketCapEntityRow = {
  collection_slug: "nba_top_shot", group_label: "LeBron James",
  editions: 138, editions_supply_known: 134, editions_priced: 131,
  minted: 310049, burned: 22637, issuer_held: 13442, collector_held: 273774,
  mcap_usd: 4_495_214.02, mcap_high_conf_usd: 2_231_644.72, mcap_minted_usd: 5_083_355.49,
  mcap_rank: 1, groups_ranked: 1362, mcap_usd_7d_ago: null, refreshed_at: "2026-10-03T21:45:00Z",
}

async function renderTile(props: { group: any; collectionDbSlug: string; match: string | null }) {
  const el = await MarketCapTile(props)
  return render(<>{el}</>)
}

describe("MarketCapTile", () => {
  it("asks get_market_cap_entity for exactly the page's own entity", async () => {
    state.data = [ROW]
    await renderTile({ group: "player", collectionDbSlug: "nba_top_shot", match: "lebron-james" })
    expect(state.calls).toEqual([{ fn: "get_market_cap_entity", args: { p_group: "player", p_collection: "nba_top_shot", p_match: "lebron-james" } }])
  })

  it("renders the cap, the rank among the collection's players, and the supply split", async () => {
    state.data = [ROW]
    const { container } = await renderTile({ group: "player", collectionDbSlug: "nba_top_shot", match: "lebron-james" })
    const t = container.textContent ?? ""
    expect(t).toContain("$4.50M")
    expect(t).toContain("#1")
    expect(t).toContain("of 1,362 players in NBA Top Shot with a known cap")
    expect(t).toContain("273,774")
    expect(t).toContain("of 310,049 minted")
    expect(t).toContain("49.6% priced from sales")
    expect(t).toContain("Covers 134 of 138 editions")
  })

  it("a FAILED read says so and shows no number", async () => {
    state.error = { message: "canceling statement due to statement timeout" }
    const { container } = await renderTile({ group: "team", collectionDbSlug: "nba_top_shot", match: "los-angeles-lakers" })
    const t = container.textContent ?? ""
    expect(t).toMatch(/couldn.t load market cap/i)
    expect(t).not.toMatch(/\$\d/)
    expect(t).not.toContain("statement timeout")
  })

  it("NO row renders nothing at all (e.g. a Pinnacle character page)", async () => {
    state.data = []
    const { container } = await renderTile({ group: "player", collectionDbSlug: "disney_pinnacle", match: "mickey-mouse" })
    expect(container.textContent).toBe("")
  })

  it("no match key → no read and nothing rendered", async () => {
    const { container } = await renderTile({ group: "edition", collectionDbSlug: "nba_top_shot", match: null })
    expect(state.calls).toHaveLength(0)
    expect(container.textContent).toBe("")
  })
})

describe("MarketCapTileBody", () => {
  it("an UNKNOWN cap reads Unknown with its upper bound — never $0 — and has no rank", () => {
    const { container } = render(
      <MarketCapTileBody
        group="player"
        row={{ ...ROW, collection_slug: "ufc_strike", mcap_usd: null, mcap_high_conf_usd: null, collector_held: null, burned: null, issuer_held: null, mcap_rank: null, groups_ranked: 0, mcap_minted_usd: 12_500, editions_supply_known: 0 }}
      />,
    )
    const t = container.textContent ?? ""
    expect(t).toContain("Unknown")
    expect(t).toContain("≤ $12.5K on minted supply")
    expect(t).not.toMatch(/\$0\b/)
    expect(t).not.toContain("#")
    // groups_ranked counts known caps only: with none known, the rank line must not
    // claim the collection has zero players (it read "of 0 players in UFC Strike").
    expect(t).not.toMatch(/of 0 players/)
    expect(t).toContain("none in UFC Strike has a known cap")
  })

  it("7-day change: shown when history exists, otherwise says when history began", () => {
    const withHistory = render(<MarketCapTileBody group="set" row={{ ...ROW, mcap_usd: 110, mcap_usd_7d_ago: 100 }} />)
    expect(withHistory.container.textContent).toContain("+10%")
    cleanup()
    const without = render(<MarketCapTileBody group="set" row={ROW} />)
    expect(without.container.textContent).toContain("history began Oct 3, 2026")
  })
})

describe("MarketCapTile — series pages", () => {
  it("asks for the series grain and names the grain in the rank line", async () => {
    state.data = [{ ...ROW, group_label: "2", groups_ranked: 8, mcap_rank: 3 }]
    const { container } = await renderTile({ group: "series", collectionDbSlug: "nba_top_shot", match: "2" })
    expect(state.calls[0].args).toEqual({ p_group: "series", p_collection: "nba_top_shot", p_match: "2" })
    expect(container.textContent).toContain("of 8 series in NBA Top Shot with a known cap")
  })
})

describe("MarketCapTile — freshness", () => {
  const NOW = Date.parse("2026-10-04T06:00:00Z")
  it("staleSince: fresh → null, older than 6 h → the PT time, no stamp → unknown", () => {
    expect(staleSince("2026-10-04T01:00:00Z", NOW)).toBeNull()
    expect(staleSince("2026-10-03T22:41:00Z", NOW)).toBe("Oct 3, 3:41 PM PT")
    expect(staleSince(null, NOW)).toBe("unknown")
    expect(staleSince("not a date", NOW)).toBe("unknown")
  })
  it("fresh figures carry no warning", () => {
    const { container } = render(<MarketCapTileBody group="player" row={ROW} stale={null} />)
    expect(container.textContent).not.toMatch(/out of date/)
  })
  it("stale figures say when they are from", () => {
    const { container } = render(<MarketCapTileBody group="player" row={ROW} stale="Oct 3, 3:41 PM PT" />)
    expect(container.textContent).toContain("These figures are from Oct 3, 3:41 PM PT")
    expect(container.textContent).toMatch(/refresh is behind/)
  })
  it("a missing refresh stamp is not read as fresh", () => {
    const { container } = render(<MarketCapTileBody group="player" row={ROW} stale="unknown" />)
    expect(container.textContent).toMatch(/not recorded/)
  })
})

describe("MarketCapTile — Top Shot edition issuer-held split", () => {
  const SPLIT_FN = "get_topshot_issuer_held_split_edition"
  const ED = { ...ROW, group_label: "Jalen Brunson 2026 NBA Finals", editions: 1, editions_supply_known: 1, issuer_held: 50 }

  it("reads the split for a Top Shot edition, with the page's own external id", async () => {
    state.data = [ED]
    state.byFn[SPLIT_FN] = { data: [{ edition_external_id: "261:8705", hidden: 50, in_packs: null, reserve: null, drops_with_packs: null, split_status: "pending: 4210 distribution(s) never read", as_of: null }], error: null }
    await renderTile({ group: "edition", collectionDbSlug: "nba_top_shot", match: "261:8705" })
    expect(state.calls.find((c) => c.fn === SPLIT_FN)?.args).toEqual({ p_external_id: "261:8705" })
  })

  it("a pending split shows the issuer-held count and says the split is not known — no 0 in packs", async () => {
    state.data = [ED]
    state.byFn[SPLIT_FN] = { data: [{ edition_external_id: "261:8705", hidden: 50, in_packs: null, reserve: null, drops_with_packs: null, split_status: "pending: x", as_of: null }], error: null }
    const { container } = await renderTile({ group: "edition", collectionDbSlug: "nba_top_shot", match: "261:8705" })
    const t = container.textContent ?? ""
    expect(t).toContain("Issuer-Held")
    expect(t).toContain("pack / reserve split not known yet")
    expect(t).not.toContain("0 in unopened packs")
    expect(t).not.toMatch(/reserve, never packed/)
  })

  it("a known split renders in-packs, drop count and reserve", async () => {
    state.data = [ED]
    state.byFn[SPLIT_FN] = { data: [{ edition_external_id: "261:8705", hidden: 50, in_packs: 6, reserve: 44, drops_with_packs: 2, split_status: "ok", as_of: "2026-10-05T16:00:00Z" }], error: null }
    const { container } = await renderTile({ group: "edition", collectionDbSlug: "nba_top_shot", match: "261:8705" })
    expect(container.textContent).toContain("6 in unopened packs (2 drops) · 44 reserve, never packed")
  })

  it("a FAILED split read says so — and the cap still renders", async () => {
    state.data = [ED]
    state.byFn[SPLIT_FN] = { data: null, error: { message: "57014" } }
    const { container } = await renderTile({ group: "edition", collectionDbSlug: "nba_top_shot", match: "261:8705" })
    const t = container.textContent ?? ""
    expect(t).toContain("$4.50M")
    expect(t).toContain("couldn't load the pack / reserve split")
    expect(t).not.toContain("57014")
  })

  it("no split read for other collections or grains", async () => {
    state.data = [ROW]
    await renderTile({ group: "edition", collectionDbSlug: "nfl_all_day", match: "abc" })
    await renderTile({ group: "player", collectionDbSlug: "nba_top_shot", match: "lebron-james" })
    expect(state.calls.some((c) => c.fn === SPLIT_FN)).toBe(false)
  })
})

describe("sevenDayChange", () => {
  it("is null whenever either side is unknown or the base is 0", () => {
    expect(sevenDayChange(110, 100)).toBeCloseTo(0.1)
    expect(sevenDayChange(null, 100)).toBeNull()
    expect(sevenDayChange(110, null)).toBeNull()
    expect(sevenDayChange(110, 0)).toBeNull()
  })
})

describe("CollectionMarketCapTile (collection overview)", () => {
  const COLL = { ...ROW, group_label: "nba_top_shot", mcap_usd: 16_330_000, mcap_rank: 1, groups_ranked: 1 }
  const CAPS = [
    { collection_slug: "nba_top_shot", mcap_usd: "51760000" },
    { collection_slug: "panini_nfl", mcap_usd: 16_330_000 },
    { collection_slug: "ufc_strike", mcap_usd: null },
  ]
  async function renderColl(slug: string | null) {
    const el = await CollectionMarketCapTile({ collectionDbSlug: slug })
    return render(<>{el}</>)
  }

  it("ranks the collection against every collection with a KNOWN cap, never against unknown ones", async () => {
    state.data = [{ ...COLL, collection_slug: "panini_nfl" }]
    state.table = { data: CAPS, error: null }
    const { container } = await renderColl("panini_nfl")
    const t = container.textContent ?? ""
    expect(t).toContain("#2")
    expect(t).toContain("of 2 collections with a known cap")
    expect(state.calls).toContainEqual({ fn: "get_market_cap_entity", args: { p_group: "collection", p_collection: "panini_nfl", p_match: "panini_nfl" } })
    expect(state.calls).toContainEqual({ fn: "from:market_cap_current", args: { filters: ["grain=collection", "is_primary=true"], limit: 50 } })
  })

  it("an UNKNOWN cap gets no rank and reads Unknown — never $0", async () => {
    state.data = [{ ...COLL, collection_slug: "ufc_strike", mcap_usd: null, mcap_high_conf_usd: null, collector_held: null }]
    state.table = { data: CAPS, error: null }
    const { container } = await renderColl("ufc_strike")
    const t = container.textContent ?? ""
    expect(t).toContain("Unknown")
    expect(t).not.toContain("$0")
    expect(t).not.toMatch(/#\d/)
  })

  it("a FAILED ranking read fails the tile — no rank is invented from a partial list", async () => {
    state.data = [COLL]
    state.table = { data: null, error: { message: "timeout" } }
    const { container } = await renderColl("nba_top_shot")
    const t = container.textContent ?? ""
    expect(t).toMatch(/couldn.t load market cap/i)
    expect(t).not.toMatch(/\$\d/)
    expect(t).not.toMatch(/#\d/)
  })

  it("no row / no slug renders nothing", async () => {
    state.data = []
    expect((await renderColl("nba_top_shot")).container.textContent).toBe("")
    state.calls = []
    expect((await renderColl(null)).container.textContent).toBe("")
    expect(state.calls).toHaveLength(0)
  })
})
