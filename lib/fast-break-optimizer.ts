// lib/fast-break-optimizer.ts
//
// Pure-function optimizer for NBA Top Shot Fast Break run lineups. No I/O —
// callers (typically /api/fast-break/optimize) hand in already-fetched
// eligibility + projection data and receive the recommended lineup back.
//
// Tiebreaker philosophy: among lineups whose projected score is within 5% of
// the best, pick the one with the lowest combined #serial. Top Shot's run
// scoring uses serial sum as a tiebreaker on the leaderboard, so two lineups
// with the same projected points should hand the user the lower-serial pick.

export type Tier = "COMMON" | "FANDOM" | "RARE" | "LEGENDARY" | "ULTIMATE"

export type EligiblePlayer = {
  nbaPlayerId: string
  fullName: string
  teamAbbr: string
  highestTier: Tier
  remainingUses: number
  bestMomentId: string
  bestSerial: number
}

export type ProjectedPlayer = EligiblePlayer & {
  projPoints: number
  projMinutes: number
  injuryStatus: string | null
  gameId: string
  opponentTeamAbbr: string
}

export type Lineup = {
  players: ProjectedPlayer[]
  captainNbaPlayerId: string | null
  projectedScore: number
  serialSum: number
}

const TIEBREAKER_TOLERANCE = 0.05
const MAX_CANDIDATE_POOL = 30

function combinations<T>(arr: T[], k: number): T[][] {
  if (k <= 0 || k > arr.length) return []
  if (k === arr.length) return [arr.slice()]
  if (k === 1) return arr.map(x => [x])

  const out: T[][] = []
  for (let i = 0; i <= arr.length - k; i++) {
    const head = arr[i]
    const tailCombos = combinations(arr.slice(i + 1), k - 1)
    for (const tail of tailCombos) out.push([head, ...tail])
  }
  return out
}

export function buildOptimalLineup(
  projectedPlayers: ProjectedPlayer[],
  lineupSize: 2 | 3,
  hasCaptain: boolean,
  // Top Shot weights the Captain's points higher than the rest of the lineup.
  // `captainMultiplier` is the factor applied to the single highest-projected
  // player in a candidate lineup (the pick that becomes Captain). 1.0 leaves
  // scoring untouched — the historical behaviour. Callers pass the calibrated
  // value (see FAST_BREAK_CAPTAIN_MULTIPLIER) so no code change is needed once
  // observed Run scoring is regressed. Ignored when `hasCaptain` is false.
  captainMultiplier: number = 1
): Lineup | null {
  const eligible = projectedPlayers.filter(
    p => p.remainingUses > 0 && p.injuryStatus !== "OUT"
  )
  if (eligible.length < lineupSize) return null

  const pool = eligible
    .slice()
    .sort((a, b) => b.projPoints - a.projPoints)
    .slice(0, MAX_CANDIDATE_POOL)

  const allCombos = combinations(pool, lineupSize)
  if (!allCombos.length) return null

  // Effective score: raw sum of projected points, plus the Captain bonus applied
  // to the lineup's top scorer when a Captain slot is in play. With the default
  // 1.0 multiplier this collapses to the raw sum, so both selection and the
  // reported projectedScore stay identical to the un-weighted model.
  const mult = hasCaptain && captainMultiplier > 0 ? captainMultiplier : 1
  const effectiveScore = (combo: ProjectedPlayer[]): number => {
    const sum = combo.reduce((acc, p) => acc + p.projPoints, 0)
    if (mult === 1) return sum
    const captainPts = combo.reduce((m, p) => (p.projPoints > m ? p.projPoints : m), -Infinity)
    return sum + (mult - 1) * captainPts
  }

  let bestScore = -Infinity
  for (const combo of allCombos) {
    const s = effectiveScore(combo)
    if (s > bestScore) bestScore = s
  }

  const threshold = bestScore * (1 - TIEBREAKER_TOLERANCE)
  let chosen: ProjectedPlayer[] | null = null
  let chosenSerial = Infinity
  let chosenScore = -Infinity
  let chosenNameKey = "￿"

  // Deterministic tiebreaker chain so the same inputs always yield the same
  // recommendation (page reload should not flip the lineup):
  //   1. Highest score within the 5% band (set above by `threshold`).
  //   2. Lowest serial sum.
  //   3. Higher score (still within the band).
  //   4. Alphabetic on the sorted-fullName join — vanishingly rare in practice
  //      but guarantees stability when 1–3 are exact ties.
  for (const combo of allCombos) {
    const score = effectiveScore(combo)
    if (score < threshold) continue
    const serialSum = combo.reduce((acc, p) => acc + p.bestSerial, 0)
    const nameKey = combo
      .map(p => p.fullName)
      .sort()
      .join("|")

    let better = false
    if (serialSum < chosenSerial) better = true
    else if (serialSum === chosenSerial) {
      if (score > chosenScore) better = true
      else if (score === chosenScore && nameKey < chosenNameKey) better = true
    }

    if (better) {
      chosen = combo
      chosenSerial = serialSum
      chosenScore = score
      chosenNameKey = nameKey
    }
  }

  if (!chosen) return null

  // Captain bonus: the top scorer in the chosen lineup takes the Captain slot,
  // and `captainMultiplier` (applied above in effectiveScore) folds the higher
  // Captain weighting into both selection and the reported projectedScore.
  // Calibration is now a config value, not a code change: once Run scoring is
  // regressed on (sum_of_proj_points, captain_proj_points), set
  // FAST_BREAK_CAPTAIN_MULTIPLIER and the caller threads it through here. The
  // default 1.0 keeps scoring unweighted until that value is dialled in.
  let captainNbaPlayerId: string | null = null
  if (hasCaptain) {
    let topPlayer = chosen[0]
    for (const p of chosen) {
      if (p.projPoints > topPlayer.projPoints) topPlayer = p
    }
    captainNbaPlayerId = topPlayer.nbaPlayerId
  }

  return {
    players: chosen,
    captainNbaPlayerId,
    projectedScore: chosenScore,
    serialSum: chosenSerial,
  }
}

export function suggestCaptainAlternates(lineup: Lineup): ProjectedPlayer[] {
  return lineup.players
    .slice()
    .sort((a, b) => {
      const aMin = Math.max(a.projMinutes, 1)
      const bMin = Math.max(b.projMinutes, 1)
      const aVar = a.projPoints * (1 - 1 / aMin)
      const bVar = b.projPoints * (1 - 1 / bMin)
      return bVar - aVar
    })
}

export function findAcquisitionGap(
  wantedNbaPlayerIds: string[],
  currentlyEligible: EligiblePlayer[]
): string[] {
  const haveWithUses = new Set(
    currentlyEligible
      .filter(p => p.remainingUses > 0)
      .map(p => p.nbaPlayerId)
  )
  return wantedNbaPlayerIds.filter(id => !haveWithUses.has(id))
}
