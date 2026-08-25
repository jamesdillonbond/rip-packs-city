// app/insights/cross-collection/page.tsx
//
// Public Cross-Collection Whale Map — SERVER component. Fetches the
// default-view cohort stats + moments-ranked wallets + TS set overlap directly
// from the cross_collection_cohort_stats / cross_collection_cohort_mat /
// cross_collection_ts_set_overlap_mat surfaces via supabaseAdmin (exactly as
// /api/public/insights/cross-collection does) and hands them to the client
// interactivity layer as `initial`. This puts the ranked tables AND the set
// drill-down links into the raw server HTML so the unique cohort content is
// crawlable. The client (CrossCollectionBoardClient) layers on sort as
// progressive enhancement and only refetches when the sort changes.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import CrossCollectionBoardClient, { type ApiResponse } from "./CrossCollectionBoardClient"

// Match the API route's 30-minute edge cache (cohort tables refresh daily/manual).
//
// ⚠ `meta.fetched_at` below is the READ time, not the data's. The client renders
// `stats.computed_at` instead — the mats' own rebuild instant, which `select("*")`
// has always returned. Measured 2026-08-21: the daily rebuild pair
// (rpc-ccm-step1/step2) had failed with a statement timeout on every run since
// 08-18, so this board was serving a 4-day-19-hour-old whale map with nothing on
// screen saying so.
export const revalidate = 1800

async function fetchInitial(): Promise<{ initial: ApiResponse; ok: boolean }> {
  try {
    const [statsRes, cohortRes, setOverlapRes] = await withBoardBudget(
      Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any).from("cross_collection_cohort_stats").select("*").limit(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("cross_collection_cohort_mat")
      .select(
        "wallet_address, n_collections, total_moments, ts_moments, allday_moments, golazos_moments, pinnacle_moments, ufc_moments, approx_fmv_usd"
      )
      .order("total_moments", { ascending: false, nullsFirst: false })
      .limit(100),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("cross_collection_ts_set_overlap_mat")
      // ⚠ `computed_at` is load-bearing and was NOT selected. This table comes
      // from a DIFFERENT mat than the cohort stats — step2, not step1 — and the
      // two drift apart when step2 fails on its own. Measured 2026-08-25: the
      // page said "Cohort data computed 15.7 hours ago" (step1's stamp) above
      // this table, which was **66.2 hours** old. Without this column the client
      // cannot know, so it silently inherited a stamp that was 50 hours wrong.
      .select("set_id, set_name, cohort_holders, moments_in_cohort, computed_at")
      .order("cohort_holders", { ascending: false })
      .limit(30),
      ]),
      "cross-collection",
    )
    // ⚠ EVERY leg's error is load-bearing. This page used to LOG all three and
    // then return `[]` / `null` regardless, so a failed read rendered an empty
    // whale map at HTTP 200 — byte-identical to "no wallet holds across
    // collections", which on this surface is a market claim. It was the only
    // /insights board with no `ok` at all.
    const errors = [statsRes.error, cohortRes.error, setOverlapRes.error].filter(Boolean)
    if (statsRes.error) console.error("[insights/cross-collection] stats", statsRes.error.message)
    if (cohortRes.error) console.error("[insights/cross-collection] cohort", cohortRes.error.message)
    if (setOverlapRes.error) console.error("[insights/cross-collection] overlap", setOverlapRes.error.message)
    return {
      initial: {
        meta: { fetched_at: new Date().toISOString() },
        stats: statsRes.data?.[0] ?? null,
        wallets: cohortRes.data ?? [],
        ts_set_overlap: setOverlapRes.data ?? [],
      },
      // ANY failed leg degrades the board: the three tables are one story, and a
      // partial answer presented whole is the thing being avoided.
      ok: errors.length === 0,
    }
  } catch (e) {
    // A BUDGET OVERRUN lands here — withBoardBudget rejects, which is how a
    // merely-SLOW read reaches the same degraded outcome a failed one now has.
    console.error("[insights/cross-collection] initial fetch", e instanceof Error ? e.message : e)
    return {
      initial: {
        meta: { fetched_at: new Date().toISOString() },
        stats: null,
        wallets: [],
        ts_set_overlap: [],
      },
      ok: false,
    }
  }
}

export default async function CrossCollectionPage() {
  const { initial, ok } = await fetchInitial()
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Whale map", ok)])} />
      <CrossCollectionBoardClient initial={initial} />
    </>
  )
}
