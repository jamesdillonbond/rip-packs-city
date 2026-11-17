import { describe, it, expect } from "vitest"
import { fetchPaniniPlayerTeams, toPlayerTeams } from "@/lib/panini/player-teams"

/** Panini player teams (2026-10-26): a failed read is ok:false (renders nothing, never "no team"). */

const db = (res: unknown, calls: unknown[] = []) => ({
  rpc: (name: string, args: unknown) => {
    calls.push([name, args])
    return Promise.resolve(res)
  },
})

describe("fetchPaniniPlayerTeams", () => {
  it("reads get_panini_player_teams and keeps its order", async () => {
    const calls: unknown[] = []
    const r = await fetchPaniniPlayerTeams("LeBron James", db({ data: [
      { league: "NBA", slug: "lakers", team_name: "Los Angeles Lakers", editions: 206 },
      { league: "NBA", slug: "cavaliers", team_name: "Cleveland Cavaliers", editions: 8 },
    ], error: null }, calls))
    expect(calls).toEqual([["get_panini_player_teams", { p_name: "LeBron James" }]])
    expect(r.ok).toBe(true)
    expect(r.teams.map((t) => t.slug)).toEqual(["lakers", "cavaliers"])
  })
  it("an error or a throw is ok:false; an empty name asks nothing", async () => {
    expect((await fetchPaniniPlayerTeams("A", db({ data: null, error: { message: "x" } }))).ok).toBe(false)
    expect((await fetchPaniniPlayerTeams("A", { rpc: () => Promise.reject(new Error("boom")) })).ok).toBe(false)
    const calls: unknown[] = []
    expect(await fetchPaniniPlayerTeams("  ", db({ data: [], error: null }, calls))).toEqual({ ok: true, teams: [] })
    expect(calls).toEqual([])
  })
  it("drops malformed rows rather than rendering a raw key", () => {
    expect(toPlayerTeams([{ league: "NBA", slug: "x" }, null, "nope", { league: "NFL", slug: "bears", team_name: "Chicago Bears", editions: 3 }]))
      .toEqual([{ league: "NFL", slug: "bears", teamName: "Chicago Bears", editions: 3 }])
    expect(toPlayerTeams({})).toEqual([])
  })
})
