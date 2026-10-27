// lib/hot-floors/snapshot.ts
//
// The precomputed Hot Floors boards (2026-10-27, #HF): `hot_floors_snapshot` holds one row per board, refreshed
// by pg_cron (Top Shot every 15 min, Panini every 30 min — refresh_hot_floors_snapshot). The live sweep reads
// cost ~2 s warm and hit the 8 s read bound cold, on 300 s ISR pages. All Day has its own table
// (lib/hot-floors/allday.ts) and the same three outcomes.
//
// Three outcomes, never two: a row (serve it), NO row yet (the caller may compute live), or a FAILED read (a
// failed read — never a silent live computation, which is the slow path the snapshot exists to avoid).

import { withBoardBudget } from "@/lib/insights/board-page-fetch"

export type HotFloorsBoard = "nba-top-shot" | "panini-blockchain"

/** One primary-key row — a keyed lookup, so a keyed-lookup budget. */
export const HOT_FLOORS_SNAPSHOT_TIMEOUT_MS = 3_000

export type HotFloorsSnapshotRead =
  | { state: "row"; payload: Record<string, unknown>; computedAt: string | null }
  | { state: "none" }
  | { state: "failed" }

export async function readHotFloorsSnapshot(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  board: HotFloorsBoard,
  timeoutMs: number = HOT_FLOORS_SNAPSHOT_TIMEOUT_MS,
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
    return { state: "row", payload: row.payload, computedAt: row.computed_at ?? null }
  } catch (e) {
    console.error(`[hot-floors] ${board} snapshot read bound:`, e instanceof Error ? e.message : e)
    return { state: "failed" }
  }
}
