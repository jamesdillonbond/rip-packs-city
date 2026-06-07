// app/insights/deals/page.tsx
//
// Public Below FMV board — SERVER component. Fetches the default board view
// (discount_pct >= 10, discount desc) directly from the public
// cross_collection_deals_board view via supabaseAdmin (exactly as
// /api/public/insights/deals does) and hands the rows to the client
// interactivity layer as `initialRows`. This puts the ranked table AND the
// per-row drill-down links (TS edition pages / Pinnacle pin pages) into the raw
// server HTML so the unique below-FMV content is crawlable. The client
// (DealsBoardClient) layers on collection/tier/confidence/sort/drill-down as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import DealsBoardClient, { type Row } from "./DealsBoardClient"

// Match the API route's 5-minute edge cache.
export const revalidate = 300

const SELECT_COLS =
  "external_id, name, player_name, set_name, tier, circulation_count, fmv_usd, confidence, low_ask, discount_pct, discount_usd, ask_updated_at, collection_slug, collection_name, render_id, detail_url, thumbnail_url"

async function fetchInitialRows(): Promise<Row[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("cross_collection_deals_board")
    .select(SELECT_COLS)
    .gte("discount_pct", 10)
    .order("discount_pct", { ascending: false })
    .limit(200)
  if (error) {
    console.error("[insights/deals] initial fetch", error.message)
    return []
  }
  return (data ?? []) as Row[]
}

export default async function DealsPage() {
  const initialRows = await fetchInitialRows()
  return (
    <DealsBoardClient
      initialRows={initialRows}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
