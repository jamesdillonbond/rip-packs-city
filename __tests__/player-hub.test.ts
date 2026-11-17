// __tests__/player-hub.test.ts
//
// lib/player-hub.ts — the data layer behind /players/<slug> (2026-10-22).
//
// Pins four properties:
//   · A NAME IS NOT A PERSON: collections group by SPORT, so a name two
//     athletes share (Larry Johnson: NBA on Top Shot, NFL on All Day + Panini)
//     is never one group, and is not indexed as one player.
//   · THREE STATES PER PANEL: "answered, no detail" (empty) is distinguishable
//     from "could not ask" (failed).
//   · TWO STATES FOR THE HUB: "no such player" (404) vs "could not ask".
//   · The slug parser accepts the site's real slugs, trailing dash included.

import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import {
  fetchPlayerHub,
  fetchPlayerHubEditions,
  fetchPlayerHubPanels,
  groupBySport,
  parsePlayerHubSlug,
  playerHubIsIndexable,
  playerHubPath,
  routableEntries,
  type PlayerHubCollection,
} from "@/lib/player-hub"

const TOP_SHOT = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const ALL_DAY = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"

const entry = (collection_slug: string, collection_id: string, n: number, sports: string[], name = "Larry Johnson"): PlayerHubCollection => ({
  collection_id,
  collection_slug,
  name,
  player_slug: "larry-johnson",
  edition_count: n,
  headshot_url: null,
  sports,
})

const LILLARD = [
  entry("panini_blockchain", PANINI, 129, ["basketball"], "Damian Lillard"),
  entry("nba_top_shot", TOP_SHOT, 68, ["basketball"], "Damian Lillard"),
]
const LARRY_JOHNSON = [
  entry("nba_top_shot", TOP_SHOT, 11, ["basketball"]),
  entry("panini_blockchain", PANINI, 6, ["football"]),
  entry("nfl_all_day", ALL_DAY, 3, ["football"]),
]

describe("parsePlayerHubSlug", () => {
  it("accepts the site's slugs, including a trailing dash (marvin-harrison-jr-)", () => {
    expect(parsePlayerHubSlug("damian-lillard")).toBe("damian-lillard")
    expect(parsePlayerHubSlug("marvin-harrison-jr-")).toBe("marvin-harrison-jr-")
    expect(parsePlayerHubSlug("Damian-Lillard")).toBe("damian-lillard")
  })
  it("rejects what cannot name a player", () => {
    expect(parsePlayerHubSlug("a")).toBeNull()
    expect(parsePlayerHubSlug("---")).toBeNull()
    expect(parsePlayerHubSlug("damian lillard")).toBeNull()
    expect(parsePlayerHubSlug("%E0%A4%A")).toBeNull()
    expect(parsePlayerHubSlug("x".repeat(121))).toBeNull()
  })
  it("builds the canonical path", () => {
    expect(playerHubPath("damian-lillard")).toBe("/players/damian-lillard")
  })
})

describe("groupBySport — a name is not a person", () => {
  it("keeps one sport in one group, in the RPC's order", () => {
    const g = groupBySport(LILLARD)
    expect(g).toHaveLength(1)
    expect(g[0].label).toBe("Basketball")
    expect(g[0].entries.map((e) => e.collection_slug)).toEqual(["panini_blockchain", "nba_top_shot"])
  })
  it("splits a name two athletes share, never merging NBA and NFL", () => {
    const g = groupBySport(LARRY_JOHNSON)
    expect(g.map((x) => x.sport).sort()).toEqual(["basketball", "football"])
    const basketball = g.find((x) => x.sport === "basketball")!
    expect(basketball.entries.map((e) => e.collection_slug)).toEqual(["nba_top_shot"])
    // Groups order by total editions: basketball 11, football 6 + 3 = 9.
    expect(g[0].sport).toBe("basketball")
  })
  it("puts a collection spanning two sports in both groups", () => {
    const g = groupBySport([entry("panini_blockchain", PANINI, 5, ["basketball", "football"])])
    expect(g.map((x) => x.sport).sort()).toEqual(["basketball", "football"])
  })
  it("groups an unknown sport as other rather than dropping it", () => {
    expect(groupBySport([entry("panini_blockchain", PANINI, 5, [])])[0].sport).toBe("other")
  })
})

describe("playerHubIsIndexable", () => {
  it("indexes a hub that gathers 2+ collections of one sport", () => {
    expect(playerHubIsIndexable({ collections: LILLARD })).toBe(true)
  })
  it("does not index two unrelated athletes, one collection each", () => {
    expect(
      playerHubIsIndexable({
        collections: [entry("nba_top_shot", TOP_SHOT, 5, ["basketball"]), entry("nfl_all_day", ALL_DAY, 3, ["football"])],
      }),
    ).toBe(false)
  })
})

describe("routableEntries", () => {
  it("skips a collection the registry cannot route to", () => {
    const r = routableEntries({ collections: [...LILLARD, entry("not_a_collection", "x", 9, ["basketball"])] })
    expect(r.map((x) => x.collection.urlSlug)).toEqual(["panini-blockchain", "nba-top-shot"])
  })
})

describe("fetchPlayerHub — 404 vs could-not-ask", () => {
  it("returns the hub on a row", async () => {
    const db = { rpc: async () => ({ data: { slug: "damian-lillard", canonical_slug: "damian-lillard", name: "Damian Lillard", collections: LILLARD }, error: null }) }
    const r = await fetchPlayerHub("damian-lillard", db)
    expect(r.ok).toBe(true)
    expect(r.hub?.collections).toHaveLength(2)
  })
  it("a clean NULL is no such player (ok:true, hub:null)", async () => {
    const db = { rpc: async () => ({ data: null, error: null }) }
    expect(await fetchPlayerHub("nobody-xyz", db)).toEqual({ hub: null, ok: true })
  })
  it("an error is could-not-ask (ok:false), never a 404", async () => {
    const db = { rpc: async () => ({ data: null, error: { message: "boom" } }) }
    expect(await fetchPlayerHub("damian-lillard", db)).toEqual({ hub: null, ok: false })
  })
  it("a throw is could-not-ask too", async () => {
    const db = { rpc: () => Promise.reject(new Error("socket")) }
    expect(await fetchPlayerHub("damian-lillard", db)).toEqual({ hub: null, ok: false })
  })
})

describe("fetchPlayerHubPanels — three states", () => {
  it("separates ok, empty and failed", async () => {
    const panels = await fetchPlayerHubPanels({ collections: LARRY_JOHNSON }, async (cid) => {
      if (cid === TOP_SHOT) return { data: { name: "Larry Johnson", edition_count: 11 }, error: null }
      if (cid === PANINI) return { data: null, error: null }
      return { data: null, error: { message: "timeout" } }
    })
    expect(Object.fromEntries(panels.map((p) => [p.collection.dbSlug, p.state]))).toEqual({
      nba_top_shot: "ok",
      panini_blockchain: "empty",
      nfl_all_day: "failed",
    })
  })
})

describe("fetchPlayerHubEditions", () => {
  it("reads get_player_editions per ok panel only, and keeps a failed read distinct from none", async () => {
    const panels = await fetchPlayerHubPanels({ collections: LILLARD }, async () => ({ data: { name: "Damian Lillard" }, error: null }))
    const calls: Array<Record<string, unknown>> = []
    const out = await fetchPlayerHubEditions(panels, async (fn, args) => {
      calls.push({ fn, ...args })
      return args.p_collection_id === PANINI ? { rows: [], ok: false } : { rows: [{ id: "e1" }], ok: true }
    })
    expect(calls.every((c) => c.fn === "get_player_editions" && c.p_limit === 6 && c.p_offset === 0)).toBe(true)
    expect(out.get(TOP_SHOT)).toEqual({ rows: [{ id: "e1" }], ok: true })
    expect(out.get(PANINI)).toEqual({ rows: [], ok: false })
  })
})
