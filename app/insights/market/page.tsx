// app/insights/market/page.tsx
//
// Public RPC Index (tier-segmented Top Shot market index) — SERVER component.
// Fetches the trailing-120-day rows directly from the public
// topshot_market_index_daily view via supabaseAdmin (exactly as
// /api/public/insights/market does) and hands them to the client layer as
// `initialRows`. The per-tier headline cards + the inline-SVG index chart +
// volume bars are computed by pure functions from these rows, so they render
// in the raw server HTML (crawlable) instead of only after JS. The client
// (MarketIndexClient) only adds the legend show/hide toggle.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { supabaseAdmin } from "@/lib/supabase"
import MarketIndexClient, { type Row } from "./MarketIndexClient"

// Match the API route's 15-minute edge cache (daily-granularity data).
export const revalidate = 900

async function fetchInitialRows(): Promise<Row[]> {
  // Trailing 120-day cutoff (inclusive), same as the route default.
  const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("topshot_market_index_daily")
    .select("d, tier, sales, volume_usd, median_px, avg_px, max_px")
    .gte("d", cutoff)
    .order("d", { ascending: true })
    .order("tier", { ascending: true })
    .limit(2000)
  if (error) {
    console.error("[insights/market] initial fetch", error.message)
    return []
  }
  return (data ?? []) as Row[]
}

export default async function MarketIndexPage() {
  const initialRows = await fetchInitialRows()
  return (
    <MarketIndexClient
      initialRows={initialRows}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
