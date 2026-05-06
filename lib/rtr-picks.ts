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
