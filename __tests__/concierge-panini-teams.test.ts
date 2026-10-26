import { describe, it, expect } from "vitest"
import { pickPaniniTeam, paniniTeamEditionKeys, readPaniniDealsForConcierge } from "@/lib/concierge/panini-boards"
import { editionKeyOfSku } from "@/lib/panini/overview-feeds"

/**
 * 2026-10-25 — the concierge's Panini team answers and deal team filter, from panini_edition_team_keys.
 * Absences pinned: a failed lookup is never an empty set ("no deals for this team"); a team with nothing
 * placed is "not placed yet"; a name two leagues share asks which.
 */

const TEAMS = [
  { league: "NBA", slug: "lakers", team_name: "Los Angeles Lakers" },
  { league: "NFL", slug: "giants", team_name: "New York Giants" },
  { league: "MLB", slug: "giants", team_name: "San Francisco Giants" },
  { league: "WNBA", slug: "fever", team_name: "Indiana Fever" },
]

function db(over: { teams?: { data: unknown; error: unknown }; keys?: { data: unknown; error: unknown } } = {}) {
  return {
    from(table: string) {
      const res = table === "teams_master" ? (over.teams ?? { data: TEAMS, error: null }) : (over.keys ?? { data: [], error: null })
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

describe("pickPaniniTeam", () => {
  it("a nickname picks the one franchise; an exact full name wins; a shared name is ambiguous", () => {
    expect(pickPaniniTeam("Lakers", TEAMS)).toMatchObject({ status: "one", team: { slug: "lakers" } })
    expect(pickPaniniTeam("fever", TEAMS)).toMatchObject({ status: "one", team: { league: "WNBA" } })
    expect(pickPaniniTeam("New York Giants", TEAMS)).toMatchObject({ status: "one", team: { league: "NFL" } })
    expect(pickPaniniTeam("Giants", TEAMS).status).toBe("ambiguous")
    expect(pickPaniniTeam("Barcelona", TEAMS).status).toBe("none")
  })
})

describe("paniniTeamEditionKeys", () => {
  it("returns the franchise's edition keys", async () => {
    const r = await paniniTeamEditionKeys(db({ keys: { data: [{ external_id: "packcard-1_1_1_1" }], error: null } }), "Lakers")
    expect(r.status).toBe("ok")
    if (r.status === "ok") expect([...r.keys]).toEqual(["packcard-1_1_1_1"])
  })
  it("nothing placed is none_placed_yet; a failed read is error — never an empty ok set", async () => {
    expect((await paniniTeamEditionKeys(db(), "Lakers")).status).toBe("none_placed_yet")
    expect((await paniniTeamEditionKeys(db({ keys: { data: null, error: { message: "x" } } }), "Lakers")).status).toBe("error")
    expect((await paniniTeamEditionKeys(db({ teams: { data: null, error: { message: "x" } } }), "Lakers")).status).toBe("error")
  })
})

describe("readPaniniDealsForConcierge — team filter", () => {
  const sku1 = "packcard-1_1_1_1__1_5"
  const sku2 = "packcard-2_2_2_2__1_5"
  const snap = async () => ({ payload: { deals_all: [
    { sku: sku1, player_name: "A", ask_usd: 10, discount_pct: 50, deal_basis: "fmv_only" },
    { sku: sku2, player_name: "B", ask_usd: 10, discount_pct: 40, deal_basis: "fmv_only" },
  ] }, ageMs: 60_000, stale: false, refreshedAt: "2026-10-26T10:00:00Z" })
  it("keeps only deals on the franchise's editions and says what 'team' means", async () => {
    const keys = new Set([editionKeyOfSku(sku1) as string])
    const out = JSON.parse(await readPaniniDealsForConcierge("https://x", { editionKeys: keys, team: "Los Angeles Lakers" }, snap as any))
    expect(out.results.map((r: { player: string }) => r.player)).toEqual(["A"])
    expect(out.team).toBe("Los Angeles Lakers")
    expect(String(out.team_note)).toMatch(/partial floor/)
  })
  it("a typed team resolves inside the reader; a failed lookup never reads as 'no deals'", async () => {
    const keysDb = db({ keys: { data: [{ external_id: editionKeyOfSku(sku2) }], error: null } })
    const ok = JSON.parse(await readPaniniDealsForConcierge("https://x", { teamQuery: "Fever", db: keysDb }, snap as any))
    expect(ok.results.map((r: { player: string }) => r.player)).toEqual(["B"])
    expect(ok.team).toBe("Indiana Fever")
    const bad = JSON.parse(await readPaniniDealsForConcierge("https://x", { teamQuery: "Fever", db: db({ keys: { data: null, error: { message: "x" } } }) }, snap as any))
    expect(bad.status).toBe("error")
    expect(bad.results).toBeUndefined()
    const amb = JSON.parse(await readPaniniDealsForConcierge("https://x", { teamQuery: "Giants", db: db() }, snap as any))
    expect(amb.status).toBe("ambiguous")
  })
})
