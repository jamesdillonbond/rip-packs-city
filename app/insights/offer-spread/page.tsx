// app/insights/offer-spread/page.tsx
//
// Public Bid vs Floor board — SERVER component. Fetches the default board view
// (low_ask >= 5, tightest par first) directly from the public
// topshot_offer_ask_spread view via supabaseAdmin (exactly as
// /api/public/insights/offer-spread does) and hands the rows to the client
// interactivity layer as `initialRows`. This puts the ranked table AND the
// per-row /nba-top-shot/edition/<external_id> drill-down links into the raw
// server HTML so the unique bid-vs-floor content is crawlable. The client
// (OfferSpreadBoardClient) layers on tier/bid-meets-floor/sort/drill-down as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import OfferSpreadBoardClient, { type Row } from "./OfferSpreadBoardClient"

// Match the API route's 5-minute edge cache; edition_offers refreshes continuously.
export const revalidate = 300

const SELECT_COLS =
  "external_id, name, player_name, set_name, tier, circulation_count, highest_offer, low_ask, offer_pct_of_ask, par_distance, spread_usd, bid_meets_ask, updated_at"

async function fetchInitialRows(): Promise<Row[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("topshot_offer_ask_spread")
    .select(SELECT_COLS)
    .gte("low_ask", 5)
    .order("par_distance", { ascending: true })
    .limit(200)
  if (error) {
    console.error("[insights/offer-spread] initial fetch", error.message)
    return []
  }
  return (data ?? []) as Row[]
}

export default async function OfferSpreadPage() {
  const initialRows = await fetchInitialRows()
  return (
    <OfferSpreadBoardClient
      initialRows={initialRows}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
