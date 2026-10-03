// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi, beforeEach } from "vitest"
import { render, cleanup } from "@testing-library/react"

// The entity-page market-cap tile. Pins the three states a reader can see —
// a failed read says so (never a number), a missing row renders NOTHING, and an
// unknown cap reads "Unknown" with its minted-supply bound (never $0) — plus the
// rank / 7-day figures and the exact RPC arguments the page sends.

const state: { calls: Array<{ fn: string; args: any }>; data: any; error: any } = { calls: [], data: [], error: null }

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      state.calls.push({ fn, args })
      return { data: state.error ? null : state.data, error: state.error }
    },
  },
}))

import MarketCapTile, { MarketCapTileBody } from "@/components/entity/MarketCapTile"
import { sevenDayChange, type MarketCapEntityRow } from "@/lib/insights/market-cap-board"

afterEach(cleanup)
beforeEach(() => {
  state.calls = []
  state.data = []
  state.error = null
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
    expect(t).toContain("of 1,362 players in NBA Top Shot")
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
  })

  it("7-day change: shown when history exists, otherwise says when history began", () => {
    const withHistory = render(<MarketCapTileBody group="set" row={{ ...ROW, mcap_usd: 110, mcap_usd_7d_ago: 100 }} />)
    expect(withHistory.container.textContent).toContain("+10%")
    cleanup()
    const without = render(<MarketCapTileBody group="set" row={ROW} />)
    expect(without.container.textContent).toContain("history began Oct 3, 2026")
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
