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
  coverage: { data: any; error: any }
  calls: any[]
} = {
  rpc: { data: [], error: null },
  coverage: { data: [], error: null },
  calls: [],
}

vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: any) => {
      state.calls.push({ fn, args })
      return state.rpc
    },
    // edition_description_coverage — the LIVE prose-coverage read.
    from: (_t: string) => ({ select: async (_c: string) => state.coverage }),
  },
}))

import { GET } from "@/app/api/search/route"

const TS = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const CANDY = "209ade70-32c5-4470-bc7c-4793d660f713"

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
      href: "/nba-top-shot/player/damian-lillard",
      collection: "nba-top-shot",
      editionCount: 65,
    })
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
    // candy_mlb is published:false — linking to /candy-mlb/player/... would 404.
    state.rpc = {
      data: [row(), row({ collection_id: CANDY, label: "Mickey Moniak", slug: "mickey-moniak" })],
      error: null,
    }
    const j = await (await GET(req("?q=mickey"))).json()
    expect(j.results).toHaveLength(1)
    expect(j.results[0].label).toBe("Damian Lillard")
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
