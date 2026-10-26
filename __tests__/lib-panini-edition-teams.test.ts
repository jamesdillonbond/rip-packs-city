import { describe, it, expect } from "vitest"
import { fetchPaniniEditionTeams } from "@/lib/panini/edition-extras"

/** fetchPaniniEditionTeams (2026-10-25): a failed read is ok:false (no chip, never "no team"); an
 *  unplaced card is an ok empty list; a key with no registry name is left out, never shown raw. */

function fakeDb(results: Record<string, { data?: unknown; error?: unknown }>, seen: string[] = []) {
  return {
    from(table: string) {
      seen.push(table)
      const res = results[table] ?? { data: [], error: null }
      const q: any = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") return (ok: (v: unknown) => unknown) => Promise.resolve(res).then(ok)
          return () => q
        },
      })
      return q
    },
  }
}

describe("fetchPaniniEditionTeams", () => {
  it("names each placed franchise from the registry", async () => {
    const r = await fetchPaniniEditionTeams("e", fakeDb({
      panini_edition_team_keys: { data: [{ franchise_keys: ["WNBA:fever", "NBA:blazers"] }], error: null },
      teams_master: { data: [{ league: "WNBA", slug: "fever", team_name: "Indiana Fever" }, { league: "NBA", slug: "blazers", team_name: "Portland Trail Blazers" }], error: null },
    }))
    expect(r).toEqual({ ok: true, teams: [
      { league: "WNBA", slug: "fever", name: "Indiana Fever" },
      { league: "NBA", slug: "blazers", name: "Portland Trail Blazers" },
    ] })
  })
  it("an unplaced card ({}) or no row is an ok empty list, without a second read", async () => {
    const seen: string[] = []
    expect(await fetchPaniniEditionTeams("e", fakeDb({ panini_edition_team_keys: { data: [{ franchise_keys: [] }], error: null } }, seen))).toEqual({ ok: true, teams: [] })
    expect(seen).toEqual(["panini_edition_team_keys"])
    expect(await fetchPaniniEditionTeams("e", fakeDb({ panini_edition_team_keys: { data: [], error: null } }))).toEqual({ ok: true, teams: [] })
  })
  it("a key the registry cannot name is left out, never shown as a raw slug", async () => {
    const r = await fetchPaniniEditionTeams("e", fakeDb({
      panini_edition_team_keys: { data: [{ franchise_keys: ["NFL:bears", "NFL:ghost"] }], error: null },
      teams_master: { data: [{ league: "NFL", slug: "bears", team_name: "Chicago Bears" }], error: null },
    }))
    expect(r.teams.map((t) => t.name)).toEqual(["Chicago Bears"])
  })
  it("either read failing is ok:false", async () => {
    expect((await fetchPaniniEditionTeams("e", fakeDb({ panini_edition_team_keys: { data: null, error: { message: "x" } } }))).ok).toBe(false)
    expect((await fetchPaniniEditionTeams("e", fakeDb({
      panini_edition_team_keys: { data: [{ franchise_keys: ["NFL:bears"] }], error: null },
      teams_master: { data: null, error: { message: "x" } },
    }))).ok).toBe(false)
    expect((await fetchPaniniEditionTeams("e", { from: () => { throw new Error("boom") } })).ok).toBe(false)
  })
})
