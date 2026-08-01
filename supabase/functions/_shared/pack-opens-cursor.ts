// Cursor-advance decision for the descending pack-opens-history backfill walkers
// (ingest-topshot-pack-opens-history, and any sibling that adopts this shape).
//
// This is the single most consequential line of a cursored backfill: how far may
// the cursor move given how much of the window we actually SCANNED and, of the
// opens we found, how many we actually RESOLVED+WROTE. Scanning a block is NOT
// the same as having written its rips — if the tx budget ran out or a tx read
// failed, advancing on scan progress alone steps the cursor over opens that were
// never written, and those pack rips are lost forever (the cursor never comes
// back down here). A bug in this arithmetic is silent: the pipeline keeps
// reporting ok=true while quietly dropping data.
//
// The edge fn keeps this logic INLINE (it is on a shelved/flaky path and is not
// being re-bundled), so this module is a faithful MIRROR unit-tested here, kept
// honest by __tests__/edge-pack-opens-cursor.test.ts (a source-drift guard that
// fails CI if the inline block and this mirror diverge). Deno + vitest both
// import plain .ts, so this is importable from either side without a toolchain.

export interface BackfillCursorInput {
  /** Current cursor. The walk goes DOWN, so a LOWER block is MORE progress. */
  cur: number
  /** Lowest reachable block (spork floor). The cursor must never go below it. */
  floor: number
  /** Lowest block confirmed fully SCANNED this tick ([scannedFloor, end] complete). */
  scannedFloor: number
  /**
   * Lowest block whose opens were fully RESOLVED and written, or null when no tx
   * was processed at all (in which case we must hold — advance nothing).
   */
  resolvedFloor: number | null
  /**
   * True when resolution stopped early with opens still unresolved (tx budget
   * exhausted or a transient tx failure). When set, the cursor may not advance
   * past the resolved floor even if more was scanned.
   */
  exhausted: boolean
}

/**
 * The safe next cursor for a descending backfill tick. Mirrors the inline block
 * in ingest-topshot-pack-opens-history's `mode === "backfill"` handler.
 */
export function nextBackfillCursor(input: BackfillCursorInput): number {
  const { cur, floor, scannedFloor, resolvedFloor, exhausted } = input
  let after = scannedFloor
  if (exhausted) after = Math.max(after, resolvedFloor ?? cur)
  after = Math.min(after, cur) // never walk back up
  after = Math.max(after, floor) // never below the reachable floor
  return after
}
