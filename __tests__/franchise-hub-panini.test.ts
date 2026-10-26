// __tests__/franchise-hub-panini.test.ts
//
// The Panini panel on /teams/<league>/<slug> (2026-10-22). Panini cards reach a
// franchise hub only through the team walk's PARTIAL match, so:
//   · no mapped card is ABSENT — the hub renders no panel, never "no Panini cards";
//   · a failed read is FAILED, never absent (that would hide an outage as a gap);
//   · the coverage figure is floored and omitted when the read carried none.

import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { fetchPaniniHubPanel, hubIsIndexable, paniniCoverage, paniniSportNoun } from "@/lib/franchise-hub"

const HUB = { league: "NBA" as const, team_slug: "blazers" }
const TS = { collection_id: "95f28a17-224a-4025-96ad-adf8a4c63bfd", collection_slug: "nba_top_shot" }
const DETAIL = {
  edition_count: 454,
  player_count: 40,
  total_circulation: 89676,
  fmv_total_usd: 9652.26,
  coverage: { sport: "Basketball", catalogued: 10898, mapped: 10329 },
}
const okEditions = async () => ({ rows: [{ route_slug: "packcard-1" }], ok: true })

describe("fetchPaniniHubPanel", () => {
  it("ok: carries the detail and the first page of cards, read with the hub's league + short slug", async () => {
    const calls: Array<[string, Record<string, unknown>]> = []
    const db = { rpc: async (fn: string, args: Record<string, unknown>) => { calls.push([fn, args]); return { data: DETAIL, error: null } } }
    const sections: Array<[string, Record<string, unknown>]> = []
    const p = await fetchPaniniHubPanel(HUB, db, async (fn, args) => { sections.push([fn, args]); return okEditions() })
    expect(p).toEqual({ state: "ok", detail: DETAIL, editions: { rows: [{ route_slug: "packcard-1" }], ok: true } })
    expect(calls).toEqual([["get_panini_franchise_panel", { p_league: "NBA", p_team_slug: "blazers" }]])
    expect(sections[0]).toEqual(["get_panini_franchise_editions", { p_league: "NBA", p_team_slug: "blazers", p_limit: 6, p_offset: 0 }])
  })

  it("absent: a clean NULL (no mapped card) renders no panel", async () => {
    const db = { rpc: async () => ({ data: null, error: null }) }
    expect(await fetchPaniniHubPanel(HUB, db, okEditions)).toEqual({ state: "absent" })
  })

  it("failed: an error is NOT absent", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "timeout" } }) }
    expect(await fetchPaniniHubPanel(HUB, db, okEditions)).toEqual({ state: "failed" })
  })

  it("failed: a throw is NOT absent", async () => {
    const db = { rpc: () => Promise.reject(new Error("socket")) }
    expect(await fetchPaniniHubPanel(HUB, db, okEditions)).toEqual({ state: "failed" })
  })

  it("keeps a failed cards read distinct from no cards", async () => {
    const db = { rpc: async () => ({ data: DETAIL, error: null }) }
    const p = await fetchPaniniHubPanel(HUB, db, async () => { throw new Error("bound") })
    expect(p).toMatchObject({ state: "ok", editions: { rows: [], ok: false } })
  })
})

describe("paniniCoverage", () => {
  it("floors the share: 94.8 % reads 94, never 95", () => {
    expect(paniniCoverage(DETAIL.coverage)).toEqual({ sport: "Basketball", noun: "basketball", mapped: 10329, catalogued: 10898, pct: 94 })
  })
  it("omits a coverage the read did not carry", () => {
    expect(paniniCoverage(null)).toBeNull()
    expect(paniniCoverage({ sport: null, catalogued: null, mapped: null })).toBeNull()
    expect(paniniCoverage({ sport: "Basketball", catalogued: 0, mapped: 0 })).toBeNull()
  })
})

describe("hubIsIndexable with a Panini panel", () => {
  it("a Panini panel with cards makes a one-collection hub a gathering hub", () => {
    expect(hubIsIndexable({ collections: [TS] }, { state: "ok", detail: DETAIL, editions: { rows: [], ok: true } })).toBe(true)
  })
  it("absent or failed Panini does not", () => {
    expect(hubIsIndexable({ collections: [TS] }, { state: "absent" })).toBe(false)
    expect(hubIsIndexable({ collections: [TS] }, { state: "failed" })).toBe(false)
    expect(hubIsIndexable({ collections: [TS] })).toBe(false)
  })
})

describe("paniniSportNoun (2026-10-25)", () => {
  it("names the WNBA, never 'womens basketball'", () => {
    expect(paniniSportNoun("Womens Basketball")).toBe("WNBA")
    expect(paniniSportNoun("Football")).toBe("football")
  })
})
