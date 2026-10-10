// lib/insights/pack-drops-default.ts
//
// The /insights/pack-drops board's default payload, in the board-cache shape
// (lib/insights/board-cache.ts), so the page gets the fresh → live → last-good
// ladder the other hot boards have (known-issues #33, decided 2026-10-10).
//
// Why the board needed it: a Vaultopolis composition read that times out makes the
// board incomplete, so `fetchScoredDrops` throws (correctly: a shorter list must not
// pass as the whole market). Without a snapshot that throw became a degraded page,
// and ISR served it for the full 15-minute window: 12 times in the two weeks to
// 10-09. Now the cron warms the board every 15 minutes. A failed live read serves the
// last COMPLETE board under its own `fetchedAt`, never a partial one.

import { supabaseAdmin } from "@/lib/supabase"
import { fetchScoredDrops, type ScoredDrop } from "@/lib/pack-drops-board"
import type { BoardLiveResult } from "@/lib/insights/board-cache"

export type PackDropsPayload = { drops: ScoredDrop[]; fetchedAt: string | null }

export async function fetchPackDropsDefault(): Promise<BoardLiveResult<PackDropsPayload>> {
  // Stamped before the read: when we asked, carried only on the ok branch.
  const askedAt = new Date().toISOString()
  try {
    const drops = await fetchScoredDrops(supabaseAdmin)
    return { payload: { drops, fetchedAt: askedAt }, ok: true, rowCount: drops.length }
  } catch (e) {
    // ok:false is never cached and sends the reader to the last-good snapshot.
    // fetchedAt null: nothing was read (R95).
    return {
      payload: { drops: [], fetchedAt: null },
      ok: false,
      rowCount: null,
      error: e instanceof Error ? e.message : String(e),
    }
  }
}
