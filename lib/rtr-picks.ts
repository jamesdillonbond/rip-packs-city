// lib/rtr-picks.ts
//
// Pure-function picks recommender for the Road to the Ring run. No I/O —
// callers pass in already-fetched odds and receive ranked picks back.
//
// Mechanic recap: in RTR every "wrong" pick refunds the user's spendable
// balance, so picks are pure +EV with downside floor. The optimal v1 strategy
// is therefore "all-in on the single highest-implied-probability side of the
// night." Splits across multiple picks become useful only once we model
// covariance across same-night games — out of scope for v1.

export type Pick = {
  gameId: string
  homeTeam: string
  awayTeam: string
  homeML: number
  awayML: number
}

export type RankedPick = {
  gameId: string
  homeTeam: string
  awayTeam: string
  pickKind: "moneyline"
  recommendedSide: "home_ml" | "away_ml"
  impliedProbability: number
  rationale: string
}

export type Allocation = {
  gameId: string
  recommendedAmount: number
}

export function americanOddsToImpliedProbability(odds: number): number {
  if (!Number.isFinite(odds) || odds === 0) return 0
  if (odds < 0) {
    const a = Math.abs(odds)
    return a / (a + 100)
  }
  return 100 / (odds + 100)
}

export function devigImpliedProbabilities(
  homeML: number,
  awayML: number
): { homeProb: number; awayProb: number } {
  const homeRaw = americanOddsToImpliedProbability(homeML)
  const awayRaw = americanOddsToImpliedProbability(awayML)
  const total = homeRaw + awayRaw
  if (total <= 0) return { homeProb: 0, awayProb: 0 }
  return { homeProb: homeRaw / total, awayProb: awayRaw / total }
}

function favoriteSide(
  homeProb: number,
  awayProb: number
): { side: "home_ml" | "away_ml"; probability: number } {
  return homeProb >= awayProb
    ? { side: "home_ml", probability: homeProb }
    : { side: "away_ml", probability: awayProb }
}

export function rankNightlyPicks(picks: Pick[]): RankedPick[] {
  const ranked: RankedPick[] = []
  for (const p of picks) {
    const { homeProb, awayProb } = devigImpliedProbabilities(p.homeML, p.awayML)
    const { side, probability } = favoriteSide(homeProb, awayProb)
    if (probability <= 0) continue

    const sideTeam = side === "home_ml" ? p.homeTeam : p.awayTeam
    const opposingTeam = side === "home_ml" ? p.awayTeam : p.homeTeam
    const pct = Math.round(probability * 100)
    const role = side === "home_ml" ? "Home" : "Away"
    ranked.push({
      gameId: p.gameId,
      homeTeam: p.homeTeam,
      awayTeam: p.awayTeam,
      pickKind: "moneyline",
      recommendedSide: side,
      impliedProbability: probability,
      rationale: `${role} favorite ${sideTeam} over ${opposingTeam} at ${pct}% implied probability`,
    })
  }
  return ranked.sort((a, b) => b.impliedProbability - a.impliedProbability)
}

export function recommendBalanceAllocation(
  spendableBalance: number,
  rankedPicks: RankedPick[]
): Allocation[] {
  if (!Number.isFinite(spendableBalance) || spendableBalance <= 0) return []
  if (!rankedPicks.length) return []
  const top = rankedPicks[0]
  return [{ gameId: top.gameId, recommendedAmount: Math.floor(spendableBalance) }]
}

// pickTonightsBest — DB-backed convenience wrapper that reads odds-enriched
// nba_games rows and returns the single highest-implied-probability pick.
// Filters to games whose odds were refreshed within the last `freshnessMin`
// minutes so we never recommend off a stale price; a missing pick is
// rendered as a "No game odds available right now" fallback in the UI.
//
// `supabase` is intentionally typed loosely — callers pass either the
// supabaseAdmin singleton or an authenticated client.

export type TonightsPick = RankedPick & {
  oddsLastSyncedAt: string
  bookmaker: string | null
  tipoffAt: string | null
  homeML: number
  awayML: number
}

interface NbaGameOddsRow {
  external_game_id: string
  home_team_abbr: string
  away_team_abbr: string
  home_moneyline: number | null
  away_moneyline: number | null
  home_win_probability_devig: number | null
  odds_bookmaker: string | null
  odds_last_synced_at: string | null
  tipoff_at: string | null
}

export async function pickTonightsBest(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  options: { freshnessMin?: number; gameDate?: string } = {}
): Promise<TonightsPick | null> {
  const freshnessMin = options.freshnessMin ?? 90
  const sinceIso = new Date(Date.now() - freshnessMin * 60_000).toISOString()

  let query = supabase
    .from("nba_games")
    .select(
      "external_game_id, home_team_abbr, away_team_abbr, home_moneyline, away_moneyline, home_win_probability_devig, odds_bookmaker, odds_last_synced_at, tipoff_at"
    )
    .gte("odds_last_synced_at", sinceIso)
    .not("home_moneyline", "is", null)
    .not("away_moneyline", "is", null)

  if (options.gameDate) query = query.eq("game_date", options.gameDate)
  query = query.order("home_win_probability_devig", { ascending: false }).limit(20)

  const { data, error } = await query
  if (error) {
    console.warn(`[pickTonightsBest] query err: ${error.message}`)
    return null
  }
  const rows = (data ?? []) as NbaGameOddsRow[]
  if (rows.length === 0) return null

  const candidates: RankedPick[] = rankNightlyPicks(
    rows.map(r => ({
      gameId: r.external_game_id,
      homeTeam: r.home_team_abbr,
      awayTeam: r.away_team_abbr,
      homeML: r.home_moneyline ?? 0,
      awayML: r.away_moneyline ?? 0,
    }))
  )
  if (candidates.length === 0) return null

  const top = candidates[0]
  const sourceRow = rows.find(r => r.external_game_id === top.gameId)
  if (!sourceRow) return null

  return {
    ...top,
    oddsLastSyncedAt: sourceRow.odds_last_synced_at ?? new Date().toISOString(),
    bookmaker: sourceRow.odds_bookmaker ?? null,
    tipoffAt: sourceRow.tipoff_at ?? null,
    homeML: sourceRow.home_moneyline ?? 0,
    awayML: sourceRow.away_moneyline ?? 0,
  }
}
