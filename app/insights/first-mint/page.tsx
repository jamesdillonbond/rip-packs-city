// app/insights/first-mint/page.tsx
//
// Public First-Mint Trophy Tracker — SERVER component. Fetches the default-view
// cohort stats + multiplier-ranked trophies directly from the public
// topshot_first_mint_trophy_stats + topshot_first_mint_trophies views via
// supabaseAdmin (exactly as /api/public/insights/first-mint does) and hands
// them to the client interactivity layer as `initial`. This puts the ranked
// table AND the per-row /nba-top-shot/edition/<external_id> drill-down links
// into the raw server HTML so the unique trophy content is crawlable. The
// client (FirstMintBoardClient) layers on multiplier/tier/drill-down filters
// as progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import FirstMintBoardClient, { type ApiResponse } from "./FirstMintBoardClient"
import { readBoardOrLive } from "@/lib/insights/board-cache"
import { fetchFirstMintDefault } from "@/lib/insights/boards"

// Match the API route's 5-minute edge cache.
export const revalidate = 300

export default async function FirstMintPage() {
  // Snapshot-cached default view with live + stale fallback (nc1 PUBLIC-BOARD-CACHING).
  const { payload } = await readBoardOrLive("first-mint", () => fetchFirstMintDefault())
  return <FirstMintBoardClient initial={payload as unknown as ApiResponse} />
}
