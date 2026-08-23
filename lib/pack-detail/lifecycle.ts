// lib/pack-detail/lifecycle.ts
//
// The two reads behind /[collection]/pack/[id] — a single pack's lifecycle, and
// the dist-id probe backing the 308 redirect to the template page.
//
// WHY THEY MOVED OUT OF page.tsx. Same two reasons as the rest of this family:
// they were UNBOUNDED (a read that is merely SLOW errors nowhere, so the page
// hung on a streaming shell that Vercel logs as a 200) and UNTESTABLE
// (`app/**/page.tsx` is measured by neither coverage gate).
//
// ⚠ The lifecycle read's `ok` contract already existed, and its history is worth
// keeping: it used to collapse into a bare `null`, so a statement timeout
// rendered the NotFoundCard — telling a visitor a pack that exists does not, and
// (because the card is served at 200) offering that page to crawlers as a
// soft-404.

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import type { PackLifecycle } from "@/app/(collections)/[collection]/pack/[id]/types"

/**
 * ⚠ Both reads are keyed lookups on one pack, not aggregates, so they get a
 * short budget rather than a board's. They run SEQUENTIALLY on the redirect path
 * (lifecycle, then the probe), so the page's ceiling is the sum: 4 + 3 = 7s.
 */
export const PACK_LIFECYCLE_TIMEOUT_MS = 4_000
export const DIST_PROBE_TIMEOUT_MS = 3_000

export interface LifecycleResult {
  lifecycle: PackLifecycle | null
  /** FALSE only when the read failed. `true` with a null lifecycle means the
   *  pack genuinely is not in the index. */
  ok: boolean
}

export async function fetchLifecycle(
  packNftId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = PACK_LIFECYCLE_TIMEOUT_MS,
): Promise<LifecycleResult> {
  try {
    const { data, error } = await withBoardBudget<{
      data: unknown
      error: { message: string } | null
    }>(
      db.rpc("get_pack_lifecycle", { p_pack_nft_id: packNftId }),
      "pack-lifecycle",
      timeoutMs,
      "pack/",
    )
    if (error) {
      console.log(`[pack-lifecycle] rpc error for ${packNftId}: ${error.message}`)
      return { lifecycle: null, ok: false }
    }
    if (!data || typeof data !== "object") return { lifecycle: null, ok: true }
    return { lifecycle: data as PackLifecycle, ok: true }
  } catch (e) {
    console.log(`[pack-lifecycle] read bound for ${packNftId}:`, e instanceof Error ? e.message : e)
    return { lifecycle: null, ok: false }
  }
}

export interface DistProbeResult {
  known: boolean
  /** FALSE only when the probe failed. See the note on the caller below. */
  ok: boolean
}

/**
 * Probe `pack_distributions` for a known dist_id match — backs the 308 fallback.
 *
 * 🚨 IT USED TO RETURN A BARE `false` ON ERROR, and the caller reads a `false` as
 * "not a distribution" and renders the **NotFoundCard**. So a failed probe told a
 * visitor a real distribution does not exist — the same conflation the lifecycle
 * read above was already fixed for, one line below it and left behind. `ok` now
 * carries the distinction so the caller can render the UnavailableCard it already
 * has instead.
 *
 * ⚠ `known: false, ok: true` is still a real answer — most pack ids are NOT
 * distribution ids, and that is the common path. Only `ok: false` may suppress
 * the not-found.
 */
export async function isKnownDistId(
  collectionUuid: string,
  candidate: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any = supabaseAdmin,
  timeoutMs: number = DIST_PROBE_TIMEOUT_MS,
): Promise<DistProbeResult> {
  try {
    const { data, error } = await withBoardBudget<{
      data: unknown
      error: { message: string } | null
    }>(
      Promise.resolve(
        db
          .from("pack_distributions")
          .select("dist_id")
          .eq("collection_id", collectionUuid)
          .eq("dist_id", candidate)
          .limit(1)
          .maybeSingle(),
      ),
      "dist-probe",
      timeoutMs,
      "pack/",
    )
    if (error) {
      console.log(`[pack-lifecycle] dist probe error for ${candidate}: ${error.message}`)
      return { known: false, ok: false }
    }
    return { known: Boolean(data), ok: true }
  } catch (e) {
    console.log(`[pack-lifecycle] dist probe bound for ${candidate}:`, e instanceof Error ? e.message : e)
    return { known: false, ok: false }
  }
}
