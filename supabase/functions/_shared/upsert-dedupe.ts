// Dedupe a batch by its ON CONFLICT key before sending it to PostgREST.
//
// WHY THIS EXISTS. A single `INSERT … ON CONFLICT DO UPDATE` statement may not
// touch the same target row twice. If a batch carries two rows sharing the
// conflict key, Postgres aborts the WHOLE statement with
//
//   21000  ON CONFLICT DO UPDATE command cannot affect row a second time
//
// so one duplicated upstream id discards every other row in the chunk. That is
// exactly what took `compute-pinnacle-pack-ev` to 100% failure from
// 2026-08-11 06:17Z: the studio-platform GQL walk began returning two nodes
// sharing a `dist_id`, the `pack_distributions` upsert threw, the function
// re-threw before Phase 3b, and Pinnacle pack EV froze — 4 failed ticks a day,
// every one with the identical error.
//
// ⚠ THE DEDUPE MUST BE COUNTED, NOT SILENT. Collapsing duplicates quietly would
// trade a loud deterministic failure for an invisible one, and "the upstream is
// emitting two nodes under one id" is a real anomaly a reader needs to see. So
// this returns the collision count and a bounded sample of the offending keys
// for the caller to put in its `pipeline_runs.extra`. Same reasoning as
// `sets_faulted` on the Top Shot catalog walker: a swallowed fault is a defect,
// a reported one is a measurement.
//
// LAST WINS, deliberately. A sequential per-row upsert — the behaviour this
// replaces conceptually — would leave the last write in place, so keeping the
// last occurrence is what makes the batched form equivalent to the unbatched
// one rather than quietly picking a different winner.

export interface DedupeResult<T> {
  /** Batch with one row per conflict key, last occurrence winning. */
  rows: T[]
  /** How many rows were dropped as duplicates (0 when the batch was clean). */
  duplicates: number
  /** Up to `sampleLimit` distinct keys that collided, for diagnostics. */
  duplicateKeys: string[]
}

/**
 * Collapse rows sharing a conflict key, keeping the LAST occurrence.
 *
 * @param rows   the batch about to be upserted
 * @param key    builds the conflict key — must use the SAME columns as the
 *               `onConflict` string, or this will not prevent the 21000
 * @param sampleLimit  cap on reported sample keys (default 5)
 */
export function dedupeByConflictKey<T>(
  rows: readonly T[],
  key: (row: T) => string,
  sampleLimit = 5,
): DedupeResult<T> {
  const byKey = new Map<string, T>()
  const collided = new Set<string>()

  for (const row of rows) {
    const k = key(row)
    if (byKey.has(k)) collided.add(k)
    // Last write wins.
    byKey.set(k, row)
  }

  return {
    rows: [...byKey.values()],
    duplicates: rows.length - byKey.size,
    duplicateKeys: [...collided].slice(0, sampleLimit),
  }
}
