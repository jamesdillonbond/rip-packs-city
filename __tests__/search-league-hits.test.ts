import { describe, it, expect, beforeEach, vi } from "vitest"

/**
 * Site search answers a league or brand (2026-11-26, lib/search/league-hits.ts).
 * - "dc" / "nascar" / "world c" lead with the publisher's page; "nba" is not "wnba";
 * - a scoped search stays inside its publisher;
 * - a failed index read adds no hits, is not cached, and is retried only after the backoff.
 */

vi.mock("@/lib/supabase", () => ({ supabaseAdmin: {} }))

import { leagueHits, loadLeagueIndex, resetLeagueIndexForTests, type LeagueIndexRow } from "@/lib/search/league-hits"

const index: LeagueIndexRow[] = [
  { publisher: "panini", slug: "nba", name: "NBA", heading: "leagues" },
  { publisher: "panini", slug: "wnba", name: "WNBA", heading: "leagues" },
  { publisher: "panini", slug: "fifa-world-cup", name: "FIFA World Cup", heading: "leagues" },
  { publisher: "panini", slug: "wwe", name: "WWE", heading: "leagues" },
  { publisher: "candy", slug: "wwe", name: "WWE", heading: "leagues" },
  { publisher: "candy", slug: "dc", name: "DC", heading: "entertainment" },
  { publisher: "candy", slug: "nascar", name: "NASCAR", heading: "leagues" },
]

function fakeDb(answers: { panini?: unknown; props?: unknown; candy?: unknown }, calls = { n: 0 }) {
  const table = (res: unknown) => {
    const b: Record<string, unknown> = {}
    for (const m of ["select", "eq", "neq", "not", "order"]) b[m] = () => b
    b.limit = async () => res
    return b
  }
  return {
    calls,
    rpc: async () => { calls.n++; return answers.panini ?? { data: { properties: [{ slug: "nba", name: "NBA", heading: "leagues" }] }, error: null } },
    from: (t: string) => table(t === "publisher_properties"
      ? answers.props ?? { data: [{ slug: "dc", name: "DC", heading: "entertainment" }, { slug: "empty", name: "Empty", heading: "leagues" }], error: null }
      : answers.candy ?? { data: [{ property_slug: "dc" }, { property_slug: "dc" }], error: null }),
  }
}

beforeEach(() => resetLeagueIndexForTests())

describe("leagueHits", () => {
  it("matches a name or a leading run of its words, and links the publisher's page", () => {
    const dc = leagueHits("dc", index, null)
    expect(dc).toHaveLength(1)
    expect(dc[0]).toMatchObject({ kind: "brand", label: "DC", href: "/candy-mlb/property/dc", collection: "candy-mlb", collectionName: "Candy" })
    expect(leagueHits("world c", index, null)[0]).toMatchObject({ kind: "league", label: "FIFA World Cup", href: "/panini-blockchain/property/fifa-world-cup" })
    expect(leagueHits("NASCAR", index, null).map((h) => h.href)).toEqual(["/candy-mlb/property/nascar"])
  })
  it("'nba' is not 'wnba'; one league at two publishers is two rows", () => {
    expect(leagueHits("nba", index, null).map((h) => h.label)).toEqual(["NBA"])
    expect(leagueHits("wwe", index, null).map((h) => h.href)).toEqual(["/candy-mlb/property/wwe", "/panini-blockchain/property/wwe"])
  })
  it("a scoped search stays inside its publisher; a short or unmatched query adds nothing", () => {
    expect(leagueHits("wwe", index, "panini-blockchain").map((h) => h.collection)).toEqual(["panini-blockchain"])
    expect(leagueHits("dc", index, "nba-top-shot")).toEqual([])
    expect(leagueHits("d", index, null)).toEqual([])
    expect(leagueHits("lillard", index, null)).toEqual([])
  })
})

describe("loadLeagueIndex", () => {
  it("lists Panini's board rows and only the Candy brands that have a collection, then serves from memory", async () => {
    const db = fakeDb({})
    const rows = await loadLeagueIndex(db)
    expect(rows).toEqual([
      { publisher: "panini", slug: "nba", name: "NBA", heading: "leagues" },
      { publisher: "candy", slug: "dc", name: "DC", heading: "entertainment" },
    ])
    await loadLeagueIndex(db)
    expect(db.calls.n).toBe(1)
  })
  it("a failed read is an empty index that is NOT remembered as the answer", async () => {
    const bad = fakeDb({ panini: { data: null, error: { message: "boom" } } })
    expect(await loadLeagueIndex(bad)).toEqual([])
    // inside the backoff the read is not repeated, and the answer is still "no hits", never a cached index
    expect(await loadLeagueIndex(fakeDb({}))).toEqual([])
    resetLeagueIndexForTests()
    expect((await loadLeagueIndex(fakeDb({}))).length).toBe(2)
  })
  it("a wrong shape is a failed read", async () => {
    expect(await loadLeagueIndex(fakeDb({ panini: { data: [], error: null } }))).toEqual([])
    resetLeagueIndexForTests()
    expect(await loadLeagueIndex(fakeDb({ candy: { data: null, error: null } }))).toEqual([])
  })
})
