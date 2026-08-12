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

import RookiesBoardClient, { type ApiResponse } from "./RookiesBoardClient"
import { readBoardOrLive } from "@/lib/insights/board-cache"
import { degradedFromSource } from "@/lib/insights/board-status"
import { fetchRookiesDefault } from "@/lib/insights/boards"

// Match the API route's 5-minute edge cache; the cohort views refresh daily.
export const revalidate = 300

export default async function RookiesPage() {
  // Snapshot-cached default view with live + stale fallback (nc1 PUBLIC-BOARD-CACHING).
  const { payload, source } = await readBoardOrLive("rookies", () => fetchRookiesDefault())
  return <RookiesBoardClient
      initial={payload as unknown as ApiResponse}
      initialDegraded={degradedFromSource(source, "2025 Rookie Index")}
    />
}
