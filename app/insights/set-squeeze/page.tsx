// app/insights/set-squeeze/page.tsx
//
// Public Set Squeeze Leaderboard — SERVER component. Fetches the default-view
// rows (avg_squeeze desc) directly from the public topshot_set_squeeze_board
// view via supabaseAdmin (exactly as /api/public/insights/set-squeeze does)
// and hands them to the client interactivity layer as `initialRows`. This puts
// the ranked table AND the per-row /nba-top-shot/set/<slug> drill-down links
// into the raw server HTML so the unique set-level squeeze content is
// crawlable. The client (SetSqueezeBoardClient) layers on series/tier/sort
// filters as progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import SetSqueezeBoardClient, { type Row } from "./SetSqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge data refreshes hourly.
export const revalidate = 300

const SELECT_COLS =
  "set_id, set_name, series, set_tier, editions_covered, avg_squeeze_pct, median_squeeze_pct, max_squeeze_pct, min_squeeze_pct, total_circ, total_locked, total_burned, total_buyable, avg_fmv_usd, fmv_covered_editions"

async function fetchInitialRows(): Promise<Row[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("topshot_set_squeeze_board")
    .select(SELECT_COLS)
    .order("avg_squeeze_pct", { ascending: false, nullsFirst: false })
    .limit(100)
  if (error) {
    console.error("[insights/set-squeeze] initial fetch", error.message)
    return []
  }
  return (data ?? []) as Row[]
}

export default async function SetSqueezePage() {
  const initialRows = await fetchInitialRows()
  return (
    <SetSqueezeBoardClient
      initialRows={initialRows}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
