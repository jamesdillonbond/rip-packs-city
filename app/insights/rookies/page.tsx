// app/insights/rookies/page.tsx
//
// Public 2025 NBA Rookie Class Index — SERVER component. Fetches the
// default-view cohort stats + GMV-ranked rows directly from the public
// topshot_2025_rookie_cohort_stats + topshot_2025_rookie_index views via
// supabaseAdmin (exactly as /api/public/insights/rookies does) and hands them
// to the client interactivity layer as `initial`. This puts the ranked table
// AND the per-player drill-down links (/nba-top-shot/player/<slug>) into the
// raw server HTML so the unique cohort content is crawlable. The client
// (RookiesBoardClient) layers on sort as progressive enhancement and only
// refetches when the user changes the sort.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import RookiesBoardClient, { type ApiResponse, type Row } from "./RookiesBoardClient"

// Match the API route's 5-minute edge cache; the cohort views refresh daily.
export const revalidate = 300

async function fetchInitial(): Promise<ApiResponse> {
  const [statsRes, indexRes] = await Promise.all([
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any).from("topshot_2025_rookie_cohort_stats").select("*").limit(1),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from("topshot_2025_rookie_index")
      .select("*")
      .order("gmv_30d", { ascending: false, nullsFirst: false })
      .limit(100),
  ])
  if (statsRes.error) console.error("[insights/rookies] stats", statsRes.error.message)
  if (indexRes.error) console.error("[insights/rookies] index", indexRes.error.message)
  return {
    meta: { fetched_at: new Date().toISOString() },
    cohort_stats: statsRes.data?.[0] ?? null,
    rows: (indexRes.data ?? []) as Row[],
  }
}

export default async function RookiesPage() {
  const initial = await fetchInitial()
  return <RookiesBoardClient initial={initial} />
}
