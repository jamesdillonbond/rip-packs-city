import { describe, it, expect } from "vitest"
import {
  americanOddsToImpliedProbability,
  devigImpliedProbabilities,
  rankNightlyPicks,
  recommendBalanceAllocation,
  pickTonightsBest,
  type Pick,
} from "@/lib/rtr-picks"

// Chainable thenable query-builder mock: every method returns itself; awaiting
// resolves the configured { data, error }. Records the methods called so we can
// assert the gameDate filter is added.
function makeSupabase(result: { data: any; error?: any }) {
  const calls: string[] = []
  const qb: any = new Proxy(
    {},
    {
      get(_t, prop) {
        if (prop === "then") return (resolve: any) => Promise.resolve({ error: null, ...result }).then(resolve)
        return (...args: any[]) => {
          calls.push(String(prop) + (prop === "eq" ? `:${args[0]}` : ""))
          return qb
        }
      },
    }
  )
  return { supabase: { from: () => qb }, calls }
}

const oddsRow = (over: Record<string, any> = {}) => ({
  external_game_id: "g1",
  home_team_abbr: "POR",
  away_team_abbr: "LAL",
  home_moneyline: -200,
  away_moneyline: 170,
  home_win_probability_devig: 0.66,
  odds_bookmaker: "DK",
  odds_last_synced_at: "2026-07-20T00:00:00Z",
  tipoff_at: "2026-07-20T02:00:00Z",
  ...over,
})

describe("americanOddsToImpliedProbability", () => {
  it("converts -150 to 0.6", () => {
    expect(americanOddsToImpliedProbability(-150)).toBeCloseTo(0.6, 4)
  })

  it("converts +180 to ~0.357", () => {
    expect(americanOddsToImpliedProbability(180)).toBeCloseTo(100 / 280, 4)
  })

  it("converts -110 to ~0.524", () => {
    expect(americanOddsToImpliedProbability(-110)).toBeCloseTo(110 / 210, 4)
  })

  it("returns 0 for invalid odds", () => {
    expect(americanOddsToImpliedProbability(0)).toBe(0)
    expect(americanOddsToImpliedProbability(NaN)).toBe(0)
  })
})

describe("devigImpliedProbabilities", () => {
  it("returns 0.5 / 0.5 for a -110 / -110 pick'em", () => {
    const { homeProb, awayProb } = devigImpliedProbabilities(-110, -110)
    expect(homeProb).toBeCloseTo(0.5, 4)
    expect(awayProb).toBeCloseTo(0.5, 4)
  })

  it("normalizes so probabilities sum to 1", () => {
    const { homeProb, awayProb } = devigImpliedProbabilities(-200, +170)
    expect(homeProb + awayProb).toBeCloseTo(1, 6)
  })

  it("preserves the favorite", () => {
    const { homeProb, awayProb } = devigImpliedProbabilities(-300, +250)
    expect(homeProb).toBeGreaterThan(awayProb)
  })
})

describe("rankNightlyPicks", () => {
  it("orders games by max(homeProb, awayProb) descending", () => {
    const picks: Pick[] = [
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", homeML: -110, awayML: -110 },
      { gameId: "g2", homeTeam: "BOS", awayTeam: "DAL", homeML: -400, awayML: +320 },
      { gameId: "g3", homeTeam: "MEM", awayTeam: "OKC", homeML: -150, awayML: +130 },
    ]
    const ranked = rankNightlyPicks(picks)
    expect(ranked[0].gameId).toBe("g2")
    expect(ranked[2].gameId).toBe("g1")
  })

  it("recommends the favorite side and labels probability in rationale", () => {
    const picks: Pick[] = [
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", homeML: -250, awayML: +210 },
    ]
    const [r] = rankNightlyPicks(picks)
    expect(r.recommendedSide).toBe("home_ml")
    expect(r.rationale).toMatch(/POR/)
    expect(r.rationale).toMatch(/%/)
  })

  it("recommends away when away is the favorite", () => {
    const picks: Pick[] = [
      { gameId: "g1", homeTeam: "DET", awayTeam: "BOS", homeML: +280, awayML: -340 },
    ]
    const [r] = rankNightlyPicks(picks)
    expect(r.recommendedSide).toBe("away_ml")
  })
})

describe("recommendBalanceAllocation", () => {
  it("allocates the full balance to the top-ranked pick", () => {
    const ranked = rankNightlyPicks([
      { gameId: "g1", homeTeam: "POR", awayTeam: "LAL", homeML: -110, awayML: -110 },
      { gameId: "g2", homeTeam: "BOS", awayTeam: "DAL", homeML: -400, awayML: +320 },
    ])
    const out = recommendBalanceAllocation(5000, ranked)
    expect(out).toEqual([{ gameId: "g2", recommendedAmount: 5000 }])
  })

  it("returns empty array when balance is non-positive", () => {
    const ranked = rankNightlyPicks([
      { gameId: "g1", homeTeam: "A", awayTeam: "B", homeML: -200, awayML: +170 },
    ])
    expect(recommendBalanceAllocation(0, ranked)).toEqual([])
  })

  it("returns empty array when no picks supplied", () => {
    expect(recommendBalanceAllocation(1000, [])).toEqual([])
  })
})

describe("pickTonightsBest", () => {
  it("returns the top-ranked pick enriched with the source odds row", async () => {
    const { supabase } = makeSupabase({
      data: [
        oddsRow({ external_game_id: "g1", home_moneyline: -110, away_moneyline: -110 }), // near coinflip
        oddsRow({ external_game_id: "g2", home_moneyline: -400, away_moneyline: 320 }), // strong favorite
      ],
    })
    const pick = await pickTonightsBest(supabase)
    expect(pick).not.toBeNull()
    expect(pick!.gameId).toBe("g2") // the biggest edge ranks first
    expect(pick!.bookmaker).toBe("DK")
    expect(pick!.tipoffAt).toBe("2026-07-20T02:00:00Z")
    expect(typeof pick!.oddsLastSyncedAt).toBe("string")
  })

  it("returns null when the query errors", async () => {
    const { supabase } = makeSupabase({ data: null, error: { message: "db down" } })
    expect(await pickTonightsBest(supabase)).toBeNull()
  })

  it("returns null when no games are fresh/available", async () => {
    const { supabase } = makeSupabase({ data: [] })
    expect(await pickTonightsBest(supabase)).toBeNull()
  })

  it("adds a game_date equality filter when gameDate is supplied", async () => {
    const { supabase, calls } = makeSupabase({ data: [oddsRow()] })
    await pickTonightsBest(supabase, { gameDate: "2026-07-20" })
    expect(calls).toContain("eq:game_date")
  })

  it("does not add the game_date filter when gameDate is omitted", async () => {
    const { supabase, calls } = makeSupabase({ data: [oddsRow()] })
    await pickTonightsBest(supabase)
    expect(calls.some((c) => c.startsWith("eq:"))).toBe(false)
  })

  it("falls back gracefully when the source row has null odds metadata", async () => {
    const { supabase } = makeSupabase({
      data: [oddsRow({ odds_last_synced_at: null, odds_bookmaker: null, tipoff_at: null })],
    })
    const pick = await pickTonightsBest(supabase)
    expect(pick!.bookmaker).toBeNull()
    expect(pick!.tipoffAt).toBeNull()
    expect(typeof pick!.oddsLastSyncedAt).toBe("string") // defaulted to now()
  })
})
