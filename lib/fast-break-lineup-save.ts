// lib/fast-break-lineup-save.ts
//
// Pure-function math for the Fast Break lineup save flow. The actual writes
// happen atomically inside the save_fast_break_lineup Postgres function;
// this module exists so the diff/idempotency logic can be unit-tested
// without standing up a database.
//
// Three save shapes:
//   - first save:        existingPlayerIds is empty → every player is "added"
//   - idempotent re-save: same set of player ids (order-independent) → no
//                        delta, captain/players-jsonb still get refreshed in
//                        case the user only reordered or swapped Captain
//   - swap:              at least one player removed AND/OR added → emit a
//                        precise delta so the route can adjust counters
//                        per-player

export type LineupDiff = {
  /** Same set of nbaPlayerIds (order-independent) AND there was a prior lineup. */
  idempotent: boolean
  /** No prior lineup row existed for this user/run/game_date. */
  isFirstSave: boolean
  /** Players present in the new lineup but not in the existing one. */
  added: string[]
  /** Players present in the existing lineup but not in the new one. */
  removed: string[]
  /** Players present in both lineups (unchanged across this save). */
  unchanged: string[]
}

/**
 * Order-independent diff between an existing lineup and an incoming save.
 *
 * Important: passing `null` for `existingPlayerIds` means "no prior row" and
 * triggers the first-save branch. Passing `[]` means "prior row existed but
 * had zero players" — vanishingly rare in practice but kept distinct so a
 * stale empty row is treated as a re-save (and won't increment uses).
 */
export function computeLineupDiff(
  existingPlayerIds: string[] | null,
  newPlayerIds: string[],
): LineupDiff {
  const isFirstSave = existingPlayerIds === null
  const existingArr = existingPlayerIds ?? []
  const existingSet = new Set(existingArr)
  const newSet = new Set(newPlayerIds)

  const added = newPlayerIds.filter(id => !existingSet.has(id))
  const removed = existingArr.filter(id => !newSet.has(id))
  const unchanged = newPlayerIds.filter(id => existingSet.has(id))

  const sameCardinality = existingSet.size === newSet.size
  const everyExistingInNew = existingArr.every(id => newSet.has(id))
  const idempotent = !isFirstSave && sameCardinality && everyExistingInNew

  return { idempotent, isFirstSave, added, removed, unchanged }
}

/**
 * Project the post-save state of a single player's `times_used` counter from
 * a known "before" value plus the diff verdict for that player. Used by the
 * tests to assert the contract that the Postgres function honors.
 *
 *   added         → before + 1
 *   removed       → max(0, before - 1)
 *   unchanged     → before
 *   idempotent    → before  (route-level path, never reaches per-player loop)
 */
export function projectTimesUsedAfter(
  before: number,
  verdict: "added" | "removed" | "unchanged",
): number {
  if (verdict === "added") return before + 1
  if (verdict === "removed") return Math.max(0, before - 1)
  return before
}

export function classifyPlayer(playerId: string, diff: LineupDiff): "added" | "removed" | "unchanged" | "absent" {
  if (diff.added.includes(playerId)) return "added"
  if (diff.removed.includes(playerId)) return "removed"
  if (diff.unchanged.includes(playerId)) return "unchanged"
  return "absent"
}
