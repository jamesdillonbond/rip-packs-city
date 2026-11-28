// lib/fast-break/threshold-optimizer.ts
//
// Regular-season Fast Break (2026-27): a night is a set of COMBINED STAT TARGETS
// ("Combine for 18 3-Pointers Made + 40 3-Pointers Attempted"), five players, one
// optional Captain at 1.5x, and the collector who wins the most nights takes the run.
// So the right objective is the PROBABILITY that the lineup's combined stats clear
// every target — not the most projected fantasy points (lib/fast-break-optimizer.ts,
// which is the playoff "score the most points" format and stays for that objective).
//
// Model: each stat total is ~Normal(mean = Σ projected, var = k_stat × Σ projected),
// k_stat measured from this season's box scores (2026-11-27, 371 players with 8+
// games: pts 3.02, reb 1.39, ast 1.22, stl 1.09, blk 1.08, 3PM 1.15, 3PA 1.06,
// FGM 1.20, FGA 1.33), times PROJECTION_ERROR_INFLATION for the projection's own
// miss. The targets are treated as independent (product of per-stat probabilities)
// — conservative when two targets move together (3PM with 3PA, FGM with FGA).
//
// Pure: no I/O. The route (app/api/fast-break/optimize) does the reads.

export type StatKey =
  | "pts" | "reb" | "ast" | "stl" | "blk"
  | "fg3m" | "fg3a" | "fgm" | "fga" | "ftm" | "fta" | "tov"

export const STAT_LABELS: Record<StatKey, string> = {
  pts: "Points", reb: "Rebounds", ast: "Assists", stl: "Steals", blk: "Blocks",
  fg3m: "3-Pointers Made", fg3a: "3-Pointers Attempted",
  fgm: "Field Goals Made", fga: "Field Goals Attempted",
  ftm: "Free Throws Made", fta: "Free Throws Attempted", tov: "Turnovers",
}

/** Variance / mean of a single player's game total, by stat (box scores 2026-10-20..11-27). */
export const STAT_DISPERSION: Record<StatKey, number> = {
  pts: 3.02, reb: 1.39, ast: 1.22, stl: 1.09, blk: 1.08,
  fg3m: 1.15, fg3a: 1.06, fgm: 1.2, fga: 1.33, ftm: 1.5, fta: 1.6, tov: 1.2,
}

/** Extra variance for the projection's own error (a projection is not the player's true mean). */
export const PROJECTION_ERROR_INFLATION = 1.3

export const DEFAULT_CAPTAIN_MULTIPLIER = 1.5

export type Targets = Partial<Record<StatKey, number>>

export type ThresholdPlayer = {
  nbaPlayerId: string
  fullName: string
  teamAbbr: string
  proj: Partial<Record<StatKey, number>>
  injuryStatus: string | null
  /** null = unlimited (Hall of Fame / Ultimate). */
  remainingUses: number | null
  totalUses: number | null
  highestTier: string
  bestMomentId: string
  bestSerial: number
  gameId: string
  opponentTeamAbbr: string
}

export type TargetOutlook = {
  stat: StatKey
  label: string
  target: number
  projected: number
  probability: number
}

export type ThresholdLineup = {
  players: ThresholdPlayer[]
  captainNbaPlayerId: string | null
  bench: ThresholdPlayer | null
  winProbability: number
  targets: TargetOutlook[]
  serialSum: number
}

const UNAVAILABLE = new Set(["OUT", "DOUBTFUL", "SUSPENSION", "INJURY_RESERVE"])

export function isAvailable(p: ThresholdPlayer): boolean {
  const s = (p.injuryStatus ?? "").toUpperCase()
  return (p.remainingUses == null || p.remainingUses > 0) && !UNAVAILABLE.has(s)
}

/** Standard normal CDF (Abramowitz–Stegun 7.1.26 via erf), |error| < 1.5e-7. */
export function normCdf(z: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2)
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t *
    Math.exp(-(z * z) / 2)
  return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y)
}

function statKeys(targets: Targets): StatKey[] {
  return (Object.keys(targets) as StatKey[]).filter(k => Number(targets[k]) > 0)
}

/** P(a lineup with this captain clears every target), plus the per-target outlook. */
export function lineupOutlook(
  players: ThresholdPlayer[],
  captainId: string | null,
  targets: Targets,
  captainMultiplier = DEFAULT_CAPTAIN_MULTIPLIER,
): { probability: number; targets: TargetOutlook[] } {
  let probability = 1
  const out: TargetOutlook[] = []
  for (const stat of statKeys(targets)) {
    const target = Number(targets[stat])
    let mean = 0
    let variance = 0
    for (const p of players) {
      const m = Math.max(0, Number(p.proj[stat] ?? 0))
      const w = p.nbaPlayerId === captainId ? captainMultiplier : 1
      mean += w * m
      variance += w * w * STAT_DISPERSION[stat] * m
    }
    variance *= PROJECTION_ERROR_INFLATION
    // Clearing a target of T means a total >= T; the continuity correction is -0.5.
    const pr = variance > 0 ? normCdf((mean - (target - 0.5)) / Math.sqrt(variance)) : mean >= target ? 1 : 0
    probability *= pr
    out.push({ stat, label: STAT_LABELS[stat], target, projected: Math.round(mean * 10) / 10, probability: pr })
  }
  return { probability, targets: out }
}

function combinations<T>(arr: T[], k: number): T[][] {
  const out: T[][] = []
  const pick: T[] = []
  const rec = (start: number) => {
    if (pick.length === k) { out.push(pick.slice()); return }
    for (let i = start; i <= arr.length - (k - pick.length); i++) {
      pick.push(arr[i]); rec(i + 1); pick.pop()
    }
  }
  if (k > 0 && k <= arr.length) rec(0)
  return out
}

/** How much of tonight's targets one player covers on his own — the pool ranking. */
export function coverageScore(p: ThresholdPlayer, targets: Targets): number {
  let s = 0
  for (const stat of statKeys(targets)) s += Number(p.proj[stat] ?? 0) / Number(targets[stat])
  return s
}

/**
 * Cost of spending a play on this player tonight: 0 for an unlimited Moment, 1/remaining
 * otherwise. Among lineups with (near-)equal odds, the one that spends the fewest scarce
 * plays is preferred — a Legendary saved tonight is a Legendary for a harder night.
 */
function usageCost(p: ThresholdPlayer): number {
  return p.remainingUses == null ? 0 : 1 / Math.max(1, p.remainingUses)
}

export type BuildOptions = {
  lineupSize?: number
  hasCaptain?: boolean
  captainMultiplier?: number
  poolSize?: number
  /** Lineups within this many probability points of the best compete on usage cost. */
  tolerance?: number
}

export function buildThresholdLineup(
  players: ThresholdPlayer[],
  targets: Targets,
  opts: BuildOptions = {},
): ThresholdLineup | null {
  const lineupSize = opts.lineupSize ?? 5
  const hasCaptain = opts.hasCaptain ?? true
  const mult = opts.captainMultiplier ?? DEFAULT_CAPTAIN_MULTIPLIER
  const poolSize = opts.poolSize ?? 20
  const tolerance = opts.tolerance ?? 0.01
  if (statKeys(targets).length === 0) return null

  const available = players.filter(isAvailable)
  if (available.length < lineupSize) return null
  const pool = available
    .slice()
    .sort((a, b) => coverageScore(b, targets) - coverageScore(a, targets) || a.fullName.localeCompare(b.fullName))
    .slice(0, Math.max(poolSize, lineupSize))

  type Cand = { combo: ThresholdPlayer[]; captain: string | null; p: number; cost: number; key: string }
  const cands: Cand[] = []
  let best = 0
  for (const combo of combinations(pool, lineupSize)) {
    const captains: (string | null)[] = hasCaptain ? combo.map(c => c.nbaPlayerId) : [null]
    let top: { captain: string | null; p: number } | null = null
    for (const cap of captains) {
      const { probability } = lineupOutlook(combo, cap, targets, mult)
      if (!top || probability > top.p) top = { captain: cap, p: probability }
    }
    if (!top) continue
    if (top.p > best) best = top.p
    cands.push({
      combo,
      captain: top.captain,
      p: top.p,
      cost: combo.reduce((a, c) => a + usageCost(c), 0),
      key: combo.map(c => c.fullName).sort().join("|"),
    })
  }
  if (!cands.length) return null

  // Deterministic: within `tolerance` of the best odds, fewest scarce plays, then higher
  // odds, then name order — the same inputs always give the same lineup.
  const chosen = cands
    .filter(c => c.p >= best - tolerance)
    .sort((a, b) => a.cost - b.cost || b.p - a.p || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))[0]

  const inLineup = new Set(chosen.combo.map(c => c.nbaPlayerId))
  const bench = pool.find(p => !inLineup.has(p.nbaPlayerId)) ?? null
  const outlook = lineupOutlook(chosen.combo, chosen.captain, targets, mult)
  return {
    players: chosen.combo,
    captainNbaPlayerId: chosen.captain,
    bench,
    winProbability: outlook.probability,
    targets: outlook.targets,
    serialSum: chosen.combo.reduce((a, c) => a + (c.bestSerial || 0), 0),
  }
}

/** Uses per run for one Moment: the higher of its price band and its tier (2026-27 rule). */
export function usesForMoment(aspUsd: number | null, tier: string | null): number | null {
  // Price bands, Top Shot help center "Fast Break" (2025-26 fatigue table).
  let byPrice: number | null = 1
  const p = aspUsd == null ? null : Number(aspUsd)
  if (p != null && p > 1000) byPrice = null
  else if (p != null && p > 300) byPrice = 4
  else if (p != null && p > 50) byPrice = 3
  else if (p != null && p > 10) byPrice = 2
  // Tier floors. Rare = 2 and Ultimate = every night are stated by Top Shot (2026-27
  // announcement); Legendary = 4 is the prior tier rule, ASSUMED until Top Shot states it.
  const t = (tier ?? "").toUpperCase()
  const byTier: number | null = t === "ULTIMATE" ? null : t === "LEGENDARY" ? 4 : t === "RARE" ? 2 : 1
  if (byPrice == null || byTier == null) return null
  return Math.max(byPrice, byTier)
}
