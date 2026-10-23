import { describe, it, expect, beforeEach, vi } from "vitest"

// Route test for /api/search (global catalog search).
//
// The load-bearing assertion is the 503: an RPC failure must NOT come back as
// a 200 with `results: []`, because that response is byte-identical to a
// legitimate "nothing matched" and would tell a user their moment does not
// exist because the database blinked. Also pinned: unpublished collections are
// dropped (their /[collection]/... routes don't exist, so the links would
// 404), and `meta` states the coverage gap rather than implying full coverage.

const state: {
  rpc: { data: any; error: any }
  keys: { data: any; error: any }
  coverage: { data: any; error: any }
  calls: any[]
} = {
  rpc: { data: [], error: null },
  keys: { data: [], error: null },
  coverage: { data: [], error: null },
  calls: [],
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      state.calls.push({ fn, args })
      // 2026-10-22: team rows resolve their franchise hub in a second call.
      if (fn === "franchise_hub_keys") return state.keys
      return state.rpc
    },
    // edition_description_coverage — the LIVE prose-coverage read.
    from: (_t: string) => ({ select: async (_c: string) => state.coverage }),
  },
}))

import { GET } from "@/app/api/search/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"
const PANINI = "d1a0a7f5-609a-49f4-a1a7-4eaac55b020b"
// Panini Blockchain — published:false, collections.is_active false, and ZERO
// rows in `editions`, so it has no entity route and never will until it gets
// one. It replaced Candy as this file's route-less fixture on 2026-09-19.
const UNROUTED = "00000000-0000-4000-8000-000000000001"

const req = (qs: string) =>
  ({ nextUrl: new URL("http://localhost/api/search" + qs) }) as any

const row = (over: Partial<any> = {}) => ({
  kind: "player",
  label: "Damian Lillard",
  sublabel: null,
  slug: "damian-lillard",
  collection_id: TS,
  collection_slug: "nba_top_shot",
  thumbnail_url: null,
  edition_count: 65,
  score: 0.9,
  ...over,
})

beforeEach(() => {
  state.keys = { data: [], error: null }
  state.rpc = { data: [], error: null }
  state.coverage = { data: [], error: null }
  state.calls = []
})

describe("GET /api/search", () => {
  it("short-circuits a query under 2 chars without touching the database", async () => {
    const res = await GET(req("?q=a"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results).toEqual([])
    expect(j.meta.reason).toBe("too_short")
    expect(state.calls).toHaveLength(0)
  })

  it("treats a whitespace-only query as too short", async () => {
    const res = await GET(req("?q=%20%20%20"))
    expect((await res.json()).meta.reason).toBe("too_short")
    expect(state.calls).toHaveLength(0)
  })

  it("maps rows to app routes with a resolved collection", async () => {
    state.rpc = { data: [row()], error: null }
    const res = await GET(req("?q=lillard"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0]).toMatchObject({
      kind: "player",
      label: "Damian Lillard",
      // 2026-10-22: player rows link the collection-agnostic hub (re-pinned from
      // /nba-top-shot/player/…; the hub redirects there when Top Shot alone has him).
      href: "/players/damian-lillard",
      collection: "nba-top-shot",
      editionCount: 65,
    })
  })

  // The 2026-10-22 defect: "damian lillard" listed a Panini row and a Top Shot
  // row, and Enter opened Panini's page alone.
  it("collapses one player's per-collection rows into ONE hub row", async () => {
    state.rpc = {
      data: [
        row({ collection_id: PANINI, collection_slug: "panini_blockchain", edition_count: 129 }),
        row({ edition_count: 68 }),
      ],
      error: null,
    }
    const j = await (await GET(req("?q=damian%20lillard"))).json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0]).toMatchObject({
      kind: "player",
      href: "/players/damian-lillard",
      collections: ["panini-blockchain", "nba-top-shot"],
      editionCount: 197,
    })
    expect(j.results[0]).not.toHaveProperty("slug")
  })

  it("503s (never 200-with-empty-results) when the search RPC fails", async () => {
    // An empty array here is indistinguishable from "nothing matched", so a DB
    // outage would render as "we have no such moment".
    state.rpc = { data: null, error: { message: "canceling statement due to statement timeout" } }
    const res = await GET(req("?q=lillard"))
    expect(res.status).toBe(503)
    const j = await res.json()
    expect(j.code).toBe("search_unavailable")
    expect(j.results).toBeUndefined()
    // The driver message must not be published to anonymous callers.
    expect(JSON.stringify(j)).not.toContain("statement timeout")
    expect(res.headers.get("Retry-After")).toBe("30")
  })

  it("drops rows whose collection has no public route", async () => {
    // ⚠ THIS FIXTURE WAS CANDY UNTIL 2026-09-19, on the stated premise
    // "candy_mlb is published:false". That premise was wrong in two ways: Candy
    // has been published:true since 2026-09-06, and what actually dropped the
    // row was its absence from lib/collection-slug.ts, which the route reads via
    // getCollectionByUuid. So this test was green for a reason it did not state,
    // and it was ALSO pinning a real defect in place — rpc_search_catalog has
    // always returned Candy hits (7 for "trout", measured live), and every one
    // of them was being thrown away before it reached the reader.
    //
    // ⚠ AND THE FIXTURE MOVED AGAIN 2026-09-27: it was Panini, whose entity
    // routes now EXIST (bridged editions, facade record) — so the Panini row is
    // no longer an unroutable one. The invariant is "a collection the facade
    // does not route", so the fixture is now a UUID no collection owns.
    state.rpc = {
      data: [row(), row({ collection_id: UNROUTED, label: "Mickey Moniak", slug: "mickey-moniak" })],
      error: null,
    }
    const j = await (await GET(req("?q=mickey"))).json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0].label).toBe("Damian Lillard")
  })

  // The other half of the same rule, and the one that was missing: a collection
  // that DOES have a public entity route must survive and be linked to it.
  it("keeps a Candy MLB hit and links it to the Candy entity route", async () => {
    state.rpc = {
      data: [row({ collection_id: CANDY, collection_slug: "candy_mlb", label: "Mike Trout", slug: "mike-trout", edition_count: 6 })],
      error: null,
    }
    const j = await (await GET(req("?q=trout"))).json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0]).toMatchObject({
      kind: "player",
      label: "Mike Trout",
      href: "/players/mike-trout", // 2026-10-22: via the player hub (redirects to /candy-mlb/player/…)
      collection: "candy-mlb",
      collectionName: "Candy MLB",
    })
  })

  // 2026-10-22: team rows open the franchise hub (which also carries Panini's
  // cards), named by the franchise; a franchise's labels collapse into one row.
  it("links a team row to its franchise hub and collapses a franchise's historic labels", async () => {
    state.rpc = {
      data: [
        row({ kind: "team", label: "Seattle SuperSonics", slug: "seattle-supersonics", edition_count: 4 }),
        row({ kind: "team", label: "Oklahoma City Thunder", slug: "oklahoma-city-thunder", edition_count: 90 }),
      ],
      error: null,
    }
    state.keys = {
      data: [
        { collection_id: TS, team_slug: "seattle-supersonics", league: "NBA", hub_slug: "thunder", team_name: "Oklahoma City Thunder" },
        { collection_id: TS, team_slug: "oklahoma-city-thunder", league: "NBA", hub_slug: "thunder", team_name: "Oklahoma City Thunder" },
      ],
      error: null,
    }
    const j = await (await GET(req("?q=thunder"))).json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0]).toMatchObject({ kind: "team", label: "Oklahoma City Thunder", href: "/teams/nba/thunder", editionCount: 94 })
    expect(j.results[0]).not.toHaveProperty("collectionId")
    const keyCall = state.calls.find((c) => c.fn === "franchise_hub_keys")
    expect(keyCall.args.p_pairs).toEqual([
      { collection_id: TS, team_slug: "seattle-supersonics" },
      { collection_id: TS, team_slug: "oklahoma-city-thunder" },
    ])
  })

  it("keeps a team row's collection link when the hub-key read fails (never a 503, never a dropped row)", async () => {
    state.rpc = { data: [row({ kind: "team", label: "Portland Trail Blazers", slug: "portland-trail-blazers" })], error: null }
    state.keys = { data: null, error: { message: "boom" } }
    const res = await GET(req("?q=blazers"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0].href).toBe("/nba-top-shot/team/portland-trail-blazers")
  })

  it("does not call the hub-key read when no team row came back", async () => {
    state.rpc = { data: [row()], error: null }
    await GET(req("?q=lillard"))
    expect(state.calls.some((c) => c.fn === "franchise_hub_keys")).toBe(false)
  })

  it("drops a row whose kind has no known route instead of guessing one", async () => {
    state.rpc = { data: [row({ kind: "series", slug: "series-4" })], error: null }
    const j = await (await GET(req("?q=series"))).json()
    expect(j.results).toEqual([])
  })

  it("scopes to a collection when given a valid url slug", async () => {
    state.rpc = { data: [], error: null }
    await GET(req("?q=lillard&collection=nba-top-shot"))
    expect(state.calls[0].args.p_collection_id).toBe(TS)
  })

  it("400s on an unknown collection rather than silently searching everything", async () => {
    const res = await GET(req("?q=lillard&collection=not-a-collection"))
    expect(res.status).toBe(400)
    expect(state.calls).toHaveLength(0)
  })

  it("clamps limit into [1,30]", async () => {
    await GET(req("?q=lillard&limit=999"))
    expect(state.calls[0].args.p_limit).toBe(30)
    state.calls = []
    await GET(req("?q=lillard&limit=-4"))
    expect(state.calls[0].args.p_limit).toBe(1)
    state.calls = []
    await GET(req("?q=lillard&limit=abc"))
    expect(state.calls[0].args.p_limit).toBe(20)
  })

  it("truncates an absurdly long query rather than passing it through", async () => {
    await GET(req("?q=" + "a".repeat(500)))
    expect(state.calls[0].args.p_q.length).toBe(80)
  })

  it("reports LIVE prose coverage in meta rather than a hardcoded percentage", async () => {
    // The backfill moves this number on every run, so a fixed string would be
    // stale the moment it ships (the Panini lesson).
    state.coverage = {
      data: [
        { collection_slug: "nba_top_shot", searchable_editions: 13197, with_description: 5885, pct: 44.6 },
        { collection_slug: "nfl_all_day", searchable_editions: 6190, with_description: 0, pct: 0 },
      ],
      error: null,
    }
    const j = await (await GET(req("?q=game%20winner"))).json()
    expect(j.meta.searches).toContain("moment description")
    expect(j.meta.note).toMatch(/nba_top_shot 44\.6% \(5885\/13197\)/)
    // A collection with zero prose must not be advertised as covered.
    expect(j.meta.note).not.toMatch(/nfl_all_day/)
    expect(j.meta.note).toMatch(/may mean we have no description/i)
  })

  it("tells the user the search matches words, not concepts", async () => {
    // The remaining narrative gap after the 2026-08-14 token-coverage fix is
    // that there is NO STEMMING: prose saying "game-winning" is unreachable by
    // the phrase "game winner". A user cannot guess that from an empty panel,
    // and "no results" alone implies the moment does not exist. The note has to
    // name the workaround, not just apologise.
    state.coverage = {
      data: [{ collection_slug: "nba_top_shot", searchable_editions: 13208, with_description: 9128, pct: 69.1 }],
      error: null,
    }
    const j = await (await GET(req("?q=game%20winner"))).json()
    expect(j.meta.note).toMatch(/matches words, not concepts/i)
    expect(j.meta.note).toMatch(/game winning/i)
    expect(j.meta.note).toMatch(/add the player's name/i)
  })

  it("says plainly when NO descriptions are loaded", async () => {
    state.coverage = {
      data: [{ collection_slug: "nba_top_shot", searchable_editions: 13197, with_description: 0, pct: 0 }],
      error: null,
    }
    const j = await (await GET(req("?q=game%20winner"))).json()
    expect(j.meta.note).toMatch(/No moment descriptions are loaded yet/i)
  })

  it("still answers the search when the coverage read fails", async () => {
    // A failed disclosure must degrade to omitting it — never fail the search,
    // and never state a number it cannot substantiate.
    state.coverage = { data: null, error: { message: "boom" } }
    state.rpc = { data: [row()], error: null }
    const res = await GET(req("?q=lillard"))
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results).toHaveLength(1)
    expect(j.meta.coverage).toBeNull()
    expect(j.meta.note).not.toMatch(/%/)
  })

  it("tolerates a non-array RPC payload without throwing", async () => {
    state.rpc = { data: { unexpected: true }, error: null }
    const res = await GET(req("?q=lillard"))
    expect(res.status).toBe(200)
    expect((await res.json()).results).toEqual([])
  })
})
