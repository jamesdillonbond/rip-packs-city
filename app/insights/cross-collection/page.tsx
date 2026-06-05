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
import CrossCollectionBoardClient, { type ApiResponse } from "./CrossCollectionBoardClient"

// Match the API route's 30-minute edge cache (cohort tables refresh daily/manual).
export const revalidate = 1800

async function fetchInitial(): Promise<ApiResponse> {
  const [statsRes, cohortRes, setOverlapRes] = await Promise.all([
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
      .select("set_id, set_name, cohort_holders, moments_in_cohort")
      .order("cohort_holders", { ascending: false })
      .limit(30),
  ])
  if (statsRes.error) console.error("[insights/cross-collection] stats", statsRes.error.message)
  if (cohortRes.error) console.error("[insights/cross-collection] cohort", cohortRes.error.message)
  if (setOverlapRes.error) console.error("[insights/cross-collection] overlap", setOverlapRes.error.message)
  return {
    meta: { fetched_at: new Date().toISOString() },
    stats: statsRes.data?.[0] ?? null,
    wallets: cohortRes.data ?? [],
    ts_set_overlap: setOverlapRes.data ?? [],
  }
}

export default async function CrossCollectionPage() {
  const initial = await fetchInitial()
  return <CrossCollectionBoardClient initial={initial} />
}
