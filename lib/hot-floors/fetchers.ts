// lib/hot-floors/fetchers.ts
//
// The single read behind /[collection]/hot-floors.
//
// WHY IT MOVED OUT OF page.tsx. Two reasons, and they are the same reasons that
// drove every other extraction in this family:
//
//  1. It was UNBOUNDED. `supabaseAdmin.rpc(...)` awaited inline by a server
//     component with no Suspense boundary — and a read that is merely SLOW
//     errors nowhere, because supabase-js resolves `{ data, error }` only when
//     the query finishes. The page's `try/catch` catches a THROW; a hang throws
//     nothing, so the document simply never completes and Vercel logs a 200.
//     `scripts/check-unbounded-server-reads.mjs` counted it for exactly this.
//
//  2. It was UNTESTABLE. `app/**/page.tsx` is measured by NEITHER coverage gate,
//     so the honest-vs-empty distinction below had nothing pinning it.
//
// ⚠ THE PAGE'S HONESTY BRANCH ALREADY EXISTED and is why this was safe to bound:
// it renders "Couldn't load hot floors right now" on `errored`, separately from
// "No sweeps detected in the last 3 days" on an empty list. Those are different
// claims — one about US, one about THE MARKET — and only the second may be made
// from a read that succeeded.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

/**
 * Wall-clock budget for the sweep read.
 *
 * ⚠ `get_topshot_hot_floors` sessionizes the Quick-Buy path over three days, so
 * it is a genuinely heavy aggregate rather than a keyed lookup — this is why the
 * budget is nearer a board's than the 3s a single indexed row gets. The page is
 * `revalidate = 300`, so a cold ISR entry performs it inline and the reader
 * waits on it.
 */
export const HOT_FLOORS_TIMEOUT_MS = 8_000

export interface HotEdition {
  external_id: string
  set_id_onchain: number | null
  play_id_onchain: number | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  thumbnail_url: string | null
  swept_sales: number
  sweep_buyers: number
  swept_spend: number | null
  last_swept_at: string | null
  floor_ask: number | null
  fmv_usd: number | null
}

/**
 * ⚠ `ok` answers *did the READ succeed*, never *were there sweeps*. An empty
 * list with `ok: true` is a real answer — three quiet days is a normal state and
 * the page is entitled to say so. `ok: false` is the only value that may
 * suppress that sentence.
 */
export interface HotFloorsResult {
  editions: HotEdition[]
  ok: boolean
}

export async function fetchHotFloors(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = HOT_FLOORS_TIMEOUT_MS,
): Promise<HotFloorsResult> {
  try {
    const { data, error } = await withBoardBudget<{
      data: { editions?: unknown } | null
      error: { message: string } | null
    }>(db.rpc("get_topshot_hot_floors", { p_days: 3 }), "hot-floors", timeoutMs, "collection/")
    if (error) {
      console.error("[hot-floors] read error:", error.message)
      return { editions: [], ok: false }
    }
    // ⚠ A non-array `editions` is NOT an empty result — it means the RPC's shape
    // changed under us, and publishing "no sweeps" from that would be a claim
    // about the market made from a payload we did not understand.
    const rows = data?.editions
    if (rows != null && !Array.isArray(rows)) {
      console.error("[hot-floors] unexpected payload shape")
      return { editions: [], ok: false }
    }
    return { editions: (rows ?? []) as HotEdition[], ok: true }
  } catch (e) {
    console.error("[hot-floors] read bound:", e instanceof Error ? e.message : e)
    return { editions: [], ok: false }
  }
}
