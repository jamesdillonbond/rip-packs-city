// lib/hot-floors/snapshot.ts
//
// The precomputed Hot Floors boards (2026-10-27, #HF): `hot_floors_snapshot` holds one row per board, refreshed
// by pg_cron (Top Shot every 15 min, Panini every 30 min — refresh_hot_floors_snapshot). The live sweep reads
// cost ~2 s warm and hit the 8 s read bound cold, on 300 s ISR pages. All Day has its own table
// (lib/hot-floors/allday.ts) and the same three outcomes.
//
// Three outcomes, never two: a current row (serve it), NO usable row — none yet, or older than its board's
// max age — (the caller computes live, bounded), or a FAILED read (a failed read — never a silent live
// computation, which is the slow path the snapshot exists to avoid).

import { withBoardBudget } from "@/lib/insights/board-page-fetch"

export type HotFloorsBoard = "nba-top-shot" | "panini-blockchain"

/** One primary-key row — a keyed lookup, so a keyed-lookup budget. */
export const HOT_FLOORS_SNAPSHOT_TIMEOUT_MS = 3_000

/**
 * A snapshot older than this is not served as the board (the refresh keeps the previous row on every
 * failure, so without a gate a stalled lane would publish an arbitrarily old "last N days" as current).
 * Eight missed 15-minute Top Shot refreshes; six missed 30-minute Panini ones. Past it the page computes
 * live (bounded), and a failed live read is a failed read.
 */
export const HOT_FLOORS_SNAPSHOT_MAX_AGE_MS: Record<HotFloorsBoard, number> = {
  "nba-top-shot": 2 * 60 * 60 * 1000,
  "panini-blockchain": 3 * 60 * 60 * 1000,
}

export type HotFloorsSnapshotRead =
  | { state: "row"; payload: Record<string, unknown>; computedAt: string }
  /** No row yet, or a row too old to stand for the board (see HOT_FLOORS_SNAPSHOT_MAX_AGE_MS). */
  | { state: "none" }
  | { state: "failed" }

export async function readHotFloorsSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  board: HotFloorsBoard,
  timeoutMs: number = HOT_FLOORS_SNAPSHOT_TIMEOUT_MS,
  nowMs: number = Date.now(),
): Promise<HotFloorsSnapshotRead> {
  try {
    const snap = await withBoardBudget<{
      data: Array<{ payload: Record<string, unknown> | null; computed_at: string | null }> | null
      error: { message: string } | null
    }>(db.from("hot_floors_snapshot").select("payload, computed_at").eq("board", board).limit(1), `hot-floors-snapshot:${board}`, timeoutMs, "collection/")
    if (snap.error) {
      console.error(`[hot-floors] ${board} snapshot read error:`, snap.error.message)
      return { state: "failed" }
    }
    const row = Array.isArray(snap.data) ? snap.data[0] : null
    if (!row?.payload) return { state: "none" }
    // An undatable row cannot prove it is current, so it is treated like a stale one.
    const age = row.computed_at ? nowMs - Date.parse(row.computed_at) : NaN
    if (!Number.isFinite(age) || age > HOT_FLOORS_SNAPSHOT_MAX_AGE_MS[board]) {
      console.warn(`[hot-floors] ${board} snapshot is stale (computed_at ${row.computed_at ?? "none"}) — computing live`)
      return { state: "none" }
    }
    return { state: "row", payload: row.payload, computedAt: row.computed_at as string }
  } catch (e) {
    console.error(`[hot-floors] ${board} snapshot read bound:`, e instanceof Error ? e.message : e)
    return { state: "failed" }
  }
}
