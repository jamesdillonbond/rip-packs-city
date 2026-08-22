// lib/insights/mv-freshness.ts
//
// DATA-AS-OF for the materialized insights boards.
//
// ⚠ WHY THIS EXISTS (2026-08-22). Three boards — deals, panini-squeeze, first-mint —
// were switched from live-computed views to materialized views the same day. That is a
// straight win on load, and it introduced ONE user-facing regression that nothing else
// in the stack could see:
//
//   `fetched_at: new Date().toISOString()` is the house convention across ~20 insights
//   routes, and for a LIVE view it is honest — the rows were computed by that fetch, so
//   fetch time IS data time. The snapshot layer stayed honest for the same reason: a
//   175-minute-old snapshot carried the 175-minute-old stamp taken when it was built.
//
//   Behind an MV that is no longer true. The fetch happens now; the rows may be up to a
//   full refresh interval old. `/insights/deals` renders that value as
//   "Updated <FreshnessStamp>", so the page was telling a collector the board was current
//   when it could be half an hour behind — on a board whose entire purpose is listings
//   that disappear. A stale "deal" is exactly the thing that wastes a collector's trip.
//
// So: read when the MV was actually refreshed, and stamp THAT.
//
// ⚠ RETURNS null, NEVER now(), WHEN IT CANNOT TELL. Falling back to the current time is
// the fabricated-answer shape this repo keeps paying for — it would restate the very lie
// this module exists to remove, and it would do it precisely when the refresh pipeline is
// broken, i.e. when the board is MOST stale. `FreshnessStamp` renders null as "—", which
// is the honest output: we do not know how old this is.
//
// Cost: one index scan on `pipeline_runs_pipeline_started_idx (pipeline, started_at DESC)`
// — measured 4 shared buffers. Cheap enough to run per board fetch.
//
// ⚠ `pipeline_runs` retains ~73h, so a board whose refresh has been dead for three days
// reports null rather than a very old timestamp. That is the correct answer for a display
// stamp (we genuinely cannot say), and the condition is separately alarmed by the
// `pipeline_cadence_watchlist` rows added with the materialisations — do not "improve"
// this by widening the lookup to compensate for a missing alarm.

import { supabaseAdmin } from "@/lib/supabase"

/** pipeline name written by each MV refresh function (see the audit_20260822_* migrations). */
export const MV_PIPELINE = {
  deals: "cross-collection-deals-mv",
  "panini-squeeze": "panini-squeeze-mv",
  "first-mint": "topshot-first-mint-mv",
} as const

export type MvBoardKey = keyof typeof MV_PIPELINE

/**
 * When the MV behind a board was last refreshed successfully, as an ISO string.
 * `null` means "cannot determine" — callers MUST render that as unknown, never as now.
 */
export async function readMvAsOf(
  board: MvBoardKey,
  db: { from: (t: string) => any } = supabaseAdmin as any
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("pipeline_runs")
      .select("started_at")
      .eq("pipeline", MV_PIPELINE[board])
      .eq("ok", true)
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle()
    if (error) return null
    const iso = (data as { started_at?: unknown } | null)?.started_at
    if (typeof iso !== "string") return null
    // Guard a malformed value rather than passing it to the UI to render as "Invalid Date".
    return Number.isNaN(new Date(iso).getTime()) ? null : iso
  } catch {
    return null
  }
}
