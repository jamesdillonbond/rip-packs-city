// __tests__/franchise-hub.test.ts
//
// lib/franchise-hub.ts — the data layer behind /teams/<league>/<slug>.
//
// The property this pins is THREE STATES PER PANEL: a collection that answered
// "no detail" (empty) must be distinguishable from one we could not ask
// (failed). Collapsing them would publish a timeout as "no cards for this team".
// And the hub resolver keeps "no such franchise" (404) apart from "could not
// ask" (retryable, never a 404).

import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import {
  fetchFranchiseHub,
  fetchHubPanels,
  franchiseHubPath,
  hubIsIndexable,
  parseHubParams,
  type FranchiseHub,
} from "@/lib/franchise-hub"

const TOP_SHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"

const hub = (collections: FranchiseHub["collections"]): FranchiseHub => ({
  league: "MLB",
  team_slug: "tigers",
  team_name: "Detroit Tigers",
  route_slug: "detroit-tigers",
  abbreviation: "DET",
  external_id: null,
  primary_color: "#0C2340",
  secondary_color: "#FA4616",
  collections,
})

describe("parseHubParams", () => {
  it("accepts a lowercase league and a short slug", () => {
    expect(parseHubParams("mlb", "tigers")).toEqual({ league: "MLB", slug: "tigers" })
    expect(parseHubParams("nba", "blazers")).toEqual({ league: "NBA", slug: "blazers" })
    expect(parseHubParams("mlb", "red-sox")).toEqual({ league: "MLB", slug: "red-sox" })
  })
  it("rejects an unknown league, an uppercase or malformed slug, and a bad escape", () => {
    expect(parseHubParams("nhl", "kings")).toBeNull()
    expect(parseHubParams("mlb", "Tigers")).toBeNull()
    expect(parseHubParams("mlb", "-tigers")).toBeNull()
    expect(parseHubParams("mlb", "tigers%2Fx")).toBeNull()
    expect(parseHubParams("mlb", "%E0%A4%A")).toBeNull()
  })
})

describe("franchiseHubPath / hubIsIndexable", () => {
  it("builds the lowercase-league path", () => {
    expect(franchiseHubPath("MLB", "tigers")).toBe("/teams/mlb/tigers")
  })
  it("indexes only a hub that gathers 2+ collections", () => {
    expect(hubIsIndexable({ collections: [{ collection_id: CANDY, collection_slug: "candy_mlb" }] })).toBe(false)
    expect(
      hubIsIndexable({
        collections: [
          { collection_id: CANDY, collection_slug: "candy_mlb" },
          { collection_id: TOP_SHOT, collection_slug: "nba_top_shot" },
        ],
      }),
    ).toBe(true)
  })
})

describe("fetchFranchiseHub — 404 vs could-not-ask", () => {
  it("a clean NULL is 'no such franchise' (ok: true)", async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: null })) }
    expect(await fetchFranchiseHub("MLB", "nope", db)).toEqual({ hub: null, ok: true })
  })
  it("an error is 'could not ask' (ok: false) — never a 404", async () => {
    const db = { rpc: vi.fn(async () => ({ data: null, error: { message: "57014 statement timeout" } })) }
    expect(await fetchFranchiseHub("MLB", "tigers", db)).toEqual({ hub: null, ok: false })
  })
  it("a throw is 'could not ask' too", async () => {
    const db = { rpc: vi.fn(async () => { throw new Error("fetch failed") }) }
    expect(await fetchFranchiseHub("MLB", "tigers", db)).toEqual({ hub: null, ok: false })
  })
  it("a row resolves, and a missing collections array reads as []", async () => {
    const row = { ...hub([]), collections: undefined }
    const db = { rpc: vi.fn(async () => ({ data: row, error: null })) }
    const res = await fetchFranchiseHub("MLB", "tigers", db)
    expect(res.ok).toBe(true)
    expect(res.hub?.team_name).toBe("Detroit Tigers")
    expect(res.hub?.collections).toEqual([])
  })
})

describe("fetchHubPanels — three states per panel", () => {
  const h = hub([{ collection_id: CANDY, collection_slug: "candy_mlb" }])

  it("ok: detail present", async () => {
    const panels = await fetchHubPanels(h, async () => ({ data: { edition_count: 4 }, error: null }))
    expect(panels).toHaveLength(1)
    expect(panels[0].state).toBe("ok")
    expect(panels[0].collection.urlSlug).toBe("candy-mlb")
  })

  it("empty: the read ANSWERED null", async () => {
    const panels = await fetchHubPanels(h, async () => ({ data: null, error: null }))
    expect(panels[0].state).toBe("empty")
  })

  it("failed: an error is NOT empty", async () => {
    const panels = await fetchHubPanels(h, async () => ({ data: null, error: { message: "timeout" } }))
    expect(panels[0].state).toBe("failed")
    expect(panels[0].state).not.toBe("empty")
  })

  it("failed: a throw is NOT empty", async () => {
    const panels = await fetchHubPanels(h, async () => {
      throw new Error("pool acquire timeout")
    })
    expect(panels[0].state).toBe("failed")
  })

  it("reads each collection with the hub's route slug, not the short slug", async () => {
    const seen: Array<[string, string]> = []
    await fetchHubPanels(h, async (c, s) => {
      seen.push([c, s])
      return { data: null, error: null }
    })
    expect(seen).toEqual([[CANDY, "detroit-tigers"]])
  })

  it("a mapped collection the app cannot route to is SKIPPED, not rendered as empty", async () => {
    const withUnknown = hub([
      { collection_id: "00000000-0000-0000-0000-000000000000", collection_slug: "mystery" },
      { collection_id: CANDY, collection_slug: "candy_mlb" },
    ])
    const panels = await fetchHubPanels(withUnknown, async () => ({ data: { edition_count: 1 }, error: null }))
    expect(panels.map((p) => p.collection.dbSlug)).toEqual(["candy_mlb"])
  })
})

// 2026-09-24 — the hub carries the CARDS, not just counts: top editions and
// recent sales per ok panel, from the team page's own RPCs. Three states each.
describe("fetchHubPanelExtras — cards per ok panel, three states each", () => {
  const h = hub([{ collection_id: CANDY, collection_slug: "candy_mlb" }])

  it("reads top editions + activity for an ok panel with the hub's route slug and the hub limits", async () => {
    const { fetchHubPanelExtras, HUB_TOP_EDITIONS, HUB_RECENT_SALES } = await import("@/lib/franchise-hub")
    const panels = await fetchHubPanels(h, async () => ({ data: { edition_count: 4 }, error: null }))
    const calls: Array<[string, Record<string, unknown>]> = []
    const extras = await fetchHubPanelExtras(h, panels, async (fn, args) => {
      calls.push([fn, args])
      return { rows: [{ route_slug: "x" }], ok: true }
    })
    expect(calls.map(([fn]) => fn).sort()).toEqual(["get_team_activity", "get_team_top_editions"])
    for (const [, args] of calls) {
      expect(args.p_collection_id).toBe(CANDY)
      expect(args.p_team_slug).toBe("detroit-tigers")
    }
    expect(calls.find(([fn]) => fn === "get_team_top_editions")?.[1].p_limit).toBe(HUB_TOP_EDITIONS)
    expect(calls.find(([fn]) => fn === "get_team_activity")?.[1].p_limit).toBe(HUB_RECENT_SALES)
    const x = extras.get(CANDY)!
    expect(x.topEditions).toEqual({ rows: [{ route_slug: "x" }], ok: true })
    expect(x.activity.ok).toBe(true)
  })

  it("a failed section is ok:false with no rows — never a measured absence", async () => {
    const { fetchHubPanelExtras } = await import("@/lib/franchise-hub")
    const panels = await fetchHubPanels(h, async () => ({ data: { edition_count: 4 }, error: null }))
    const extras = await fetchHubPanelExtras(h, panels, async (fn) => {
      if (fn === "get_team_activity") throw new Error("pool acquire timeout")
      return { rows: [], ok: false }
    })
    const x = extras.get(CANDY)!
    expect(x.topEditions).toEqual({ rows: [], ok: false })
    expect(x.activity).toEqual({ rows: [], ok: false })
  })

  it("empty and failed panels get no extras (nothing to read for)", async () => {
    const { fetchHubPanelExtras } = await import("@/lib/franchise-hub")
    const panels = await fetchHubPanels(h, async () => ({ data: null, error: null }))
    let calls = 0
    const extras = await fetchHubPanelExtras(h, panels, async () => {
      calls++
      return { rows: [], ok: true }
    })
    expect(calls).toBe(0)
    expect(extras.size).toBe(0)
  })
})
