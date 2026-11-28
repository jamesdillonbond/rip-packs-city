// lib/fast-break/track-record.ts
//
// Fast Break track record (2026-11-28): score the lineup the model would have played from the
// whole slate against what actually happened. The prediction is stored BEFORE first tipoff by
// /api/cron/fast-break-predictions (the projection blend folds every finished game into the
// season line, so a "prediction" written afterwards would already know the answer); this file
// is the pure scoring half, so it can be tested without a database.
//
// Rules applied, matching Top Shot's 2026-27 regular season as documented in
// docs/features/fast-break.md:
//   * the Captain's stats count DEFAULT_CAPTAIN_MULTIPLIER (1.5×);
//   * the bench player replaces a starter who does not play. Top Shot does not say whether a
//     benched-in player inherits the Captain bonus, so a sub always counts 1× (the cautious read);
//   * a target is cleared when the lineup's total is at or above it.
// Three states, never two: `pending` until every game a pick played in is final AND has box-score
// rows. A final game with box rows but no row for a pick means he did not play.

import { DEFAULT_CAPTAIN_MULTIPLIER, type StatKey, type Targets } from "./threshold-optimizer"

/** Projection column for each target stat (nba_player_projections). */
export const PROJ_COLUMN: Record<StatKey, string> = {
  pts: "proj_points", reb: "proj_rebounds", ast: "proj_assists", stl: "proj_steals",
  blk: "proj_blocks", tov: "proj_turnovers", fg3m: "proj_threes", fg3a: "proj_three_attempts",
  fgm: "proj_fgm", fga: "proj_fga", ftm: "proj_ftm", fta: "proj_fta",
}

export type PredictedPick = {
  id: string
  name: string | null
  team: string | null
  gameId: string
  captain: boolean
  bench: boolean
}

export type BoxLine = { didPlay: boolean } & Partial<Record<StatKey, number | null>>

export type GameState = { final: boolean; hasBoxRows: boolean }

export type ScoreResult =
  | { state: "pending"; reason: "game_not_final" | "box_score_missing" }
  | {
      state: "scored"
      cleared: boolean
      totals: Partial<Record<StatKey, number>>
      used: string[]
      benchUsed: boolean
    }

export function scorePrediction(
  picks: PredictedPick[],
  targets: Targets,
  box: Map<string, BoxLine>,
  games: Map<string, GameState>,
  captainMultiplier = DEFAULT_CAPTAIN_MULTIPLIER,
): ScoreResult {
  for (const p of picks) {
    const g = games.get(p.gameId)
    if (!g || !g.final) return { state: "pending", reason: "game_not_final" }
    if (!g.hasBoxRows) return { state: "pending", reason: "box_score_missing" }
  }
  const played = (p: PredictedPick) => box.get(p.id)?.didPlay === true
  const starters = picks.filter(p => !p.bench)
  const bench = picks.find(p => p.bench) ?? null

  const lineup: Array<{ pick: PredictedPick; weight: number }> = []
  let benchUsed = false
  for (const s of starters) {
    if (played(s)) {
      lineup.push({ pick: s, weight: s.captain ? captainMultiplier : 1 })
    } else if (bench && !benchUsed && played(bench)) {
      lineup.push({ pick: bench, weight: 1 })
      benchUsed = true
    }
  }

  const totals: Partial<Record<StatKey, number>> = {}
  let cleared = true
  for (const stat of Object.keys(targets) as StatKey[]) {
    const target = Number(targets[stat])
    let sum = 0
    for (const { pick, weight } of lineup) sum += weight * Number(box.get(pick.id)?.[stat] ?? 0)
    totals[stat] = Math.round(sum * 10) / 10
    if (sum < target) cleared = false
  }
  return { state: "scored", cleared, totals, used: lineup.map(l => l.pick.id), benchUsed }
}

export type TrackRecord = { scored: number; cleared: number; avgPredicted: number | null; pending: number }

/** Summarise prediction rows; avgPredicted is over the SCORED nights only, so the two compare. */
export function summarizeTrackRecord(rows: Array<{ predicted_p: number | string; cleared: boolean | null }>): TrackRecord {
  const scored = rows.filter(r => r.cleared !== null)
  return {
    scored: scored.length,
    cleared: scored.filter(r => r.cleared === true).length,
    avgPredicted: scored.length ? scored.reduce((a, r) => a + Number(r.predicted_p), 0) / scored.length : null,
    pending: rows.length - scored.length,
  }
}
