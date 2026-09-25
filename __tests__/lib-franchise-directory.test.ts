// 2026-09-25 — the /teams hub directory reads one get_teams_for_league per
// league. Three states per league, never collapsed: a FAILED read is
// `state: "failed"` (rendered "unavailable"), an answered-empty league is
// `state: "ok"` with no teams, and a platform-wide failure is okLeagues 0.

import { describe, it, expect, vi } from "vitest"
import { fetchFranchiseDirectory } from "@/lib/franchise-directory"
import { LEAGUES } from "@/lib/teams"

const team = (slug: string) => ({ slug, team_name: slug.toUpperCase(), abbreviation: slug.slice(0, 3).toUpperCase(), external_id: null, primary_color: "#000", secondary_color: "#fff", has_moments: true })

describe("fetchFranchiseDirectory", () => {
  it("asks every league once and keeps each answer separate", async () => {
    const rpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      if (args.p_league === "NFL") return { data: null, error: { message: "canceling statement due to statement timeout" } }
      if (args.p_league === "MLB") return { data: [], error: null }
      return { data: [team("blazers"), team("lakers"), { junk: true }], error: null }
    })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const dir = await fetchFranchiseDirectory({ rpc })
    spy.mockRestore()

    expect(rpc).toHaveBeenCalledTimes(LEAGUES.length)
    expect(rpc.mock.calls.every((c) => c[0] === "get_teams_for_league")).toBe(true)
    const by = Object.fromEntries(dir.leagues.map((l) => [l.league, l]))
    expect(by.NFL.state).toBe("failed")
    expect(by.NFL.teams).toEqual([])
    expect(by.MLB.state).toBe("ok")
    expect(by.MLB.teams).toEqual([])
    expect(by.NBA.state).toBe("ok")
    expect(by.NBA.teams.map((t) => t.slug)).toEqual(["blazers", "lakers"]) // the junk row is dropped
    expect(dir.okLeagues).toBe(LEAGUES.length - 1)
    // order is the LEAGUES order, not arrival order
    expect(dir.leagues.map((l) => l.league)).toEqual(LEAGUES.map((l) => l.value))
  })

  it("a thrown read is failed, not empty, and a platform-wide failure is okLeagues 0", async () => {
    const rpc = vi.fn(async () => { throw new Error("fetch failed") })
    const spy = vi.spyOn(console, "error").mockImplementation(() => {})
    const dir = await fetchFranchiseDirectory({ rpc })
    spy.mockRestore()
    expect(dir.leagues.every((l) => l.state === "failed")).toBe(true)
    expect(dir.okLeagues).toBe(0)
  })
})
