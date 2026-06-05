// app/insights/pinnacle-scarcity/page.tsx
//
// Public Pinnacle Scarcity Board — SERVER component. Fetches the default-view
// rows (scarcity desc) directly from the public pinnacle_scarcity_board view
// via supabaseAdmin (exactly as /api/public/insights/pinnacle-scarcity does)
// and hands them to the client interactivity layer as `initialRows`. This puts
// the ranked table AND the per-row /pinnacle/moment/<id> drill-down links into
// the raw server HTML so the unique scarcity content is crawlable. The client
// (PinnacleScarcityBoardClient) layers on franchise/chasers/sort filters as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import PinnacleScarcityBoardClient, { type Row } from "./PinnacleScarcityBoardClient"

// Match the API route's 30-minute edge cache (pinnacle_editions changes slowly).
export const revalidate = 1800

const SELECT_COLS =
  "edition_id, character_name, franchise, set_name, variant_type, mint_count, is_chaser, ask_price, variant_avg_mint, scarcity_vs_variant_pct, fmv_usd, fmv_confidence, thumbnail_url"

async function fetchInitialRows(): Promise<Row[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("pinnacle_scarcity_board")
    .select(SELECT_COLS)
    .order("scarcity_vs_variant_pct", { ascending: false, nullsFirst: false })
    .limit(100)
  if (error) {
    console.error("[insights/pinnacle-scarcity] initial fetch", error.message)
    return []
  }
  return (data ?? []) as Row[]
}

export default async function PinnacleScarcityPage() {
  const initialRows = await fetchInitialRows()
  return (
    <PinnacleScarcityBoardClient
      initialRows={initialRows}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
