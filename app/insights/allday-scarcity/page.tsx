// app/insights/allday-scarcity/page.tsx
//
// Public NFL All Day Scarcity Board — SERVER component. Fetches the default-view
// rows (scarcity desc, statistically-meaningful cohort) directly from the public
// allday_scarcity_board view via supabaseAdmin (exactly as the API route does)
// and hands them to the client interactivity layer as `initialRows`. This puts
// the ranked table AND the per-row /nfl-all-day/edition/<external_id> drill-down
// links into the raw server HTML so the unique scarcity content is crawlable.
// The client (AllDayScarcityBoardClient) layers on tier/sort filters as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import AllDayScarcityBoardClient, { type Row } from "./AllDayScarcityBoardClient"

// Match the API route's 30-minute edge cache (editions change slowly).
export const revalidate = 1800

const SELECT_COLS =
  "external_id, player_name, set_name, tier, team_name, series, mint_count, family_avg_mint, family_size, scarcity_vs_family_pct, fmv_usd, fmv_confidence, thumbnail_url"

// Default board view: the honest "scarce" cohort — families with >= 3 members
// (so the average mean means something) and only editions actually scarcer than
// their family. Mirrors the API route defaults.
// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the table rendered EMPTY at HTTP 200 — byte-identical
// to "no edition is scarcer than its family", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("allday_scarcity_board")
    .select(SELECT_COLS)
    .gte("family_size", 3)
    .gt("scarcity_vs_family_pct", 0)
    .order("scarcity_vs_family_pct", { ascending: false, nullsFirst: false })
    .limit(100)
  if (error) {
    console.error("[insights/allday-scarcity] initial fetch", error.message)
    return { rows: [], ok: false }
  }
  return { rows: (data ?? []) as Row[], ok: true }
}

export default async function AllDayScarcityPage() {
  const { rows, ok } = await fetchInitialRows()
  return (
    <AllDayScarcityBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Scarcity board", ok)])}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
