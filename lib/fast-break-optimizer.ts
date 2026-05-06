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
  hasCaptain: boolean
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

  let bestScore = -Infinity
  for (const combo of allCombos) {
    const s = combo.reduce((acc, p) => acc + p.projPoints, 0)
    if (s > bestScore) bestScore = s
  }

  const threshold = bestScore * (1 - TIEBREAKER_TOLERANCE)
  let chosen: ProjectedPlayer[] | null = null
  let chosenSerial = Infinity
  let chosenScore = -Infinity

  for (const combo of allCombos) {
    const score = combo.reduce((acc, p) => acc + p.projPoints, 0)
    if (score < threshold) continue
    const serialSum = combo.reduce((acc, p) => acc + p.bestSerial, 0)
    if (
      serialSum < chosenSerial ||
      (serialSum === chosenSerial && score > chosenScore)
    ) {
      chosen = combo
      chosenSerial = serialSum
      chosenScore = score
    }
  }

  if (!chosen) return null

  // TODO(captain-bonus): Top Shot weights Captain points higher than the rest
  // of the lineup but the multiplier hasn't been calibrated against observed
  // run scoring yet. v1 flags the Captain without adjusting projectedScore.
  // Calibrate after Run 2 finishes and we can regress observed totals on
  // (sum_of_proj_points, captain_proj_points).
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
