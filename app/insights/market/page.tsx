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
import { fetchAllPaged } from "@/lib/supabase-paginate"
import MarketIndexClient, { type Row } from "./MarketIndexClient"

// Match the API route's 15-minute edge cache (daily-granularity data).
export const revalidate = 900

async function fetchInitialRows(): Promise<Row[]> {
  // Trailing 120-day cutoff (inclusive), same as the route default.
  const cutoff = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // 686 rows today (121 days x <=7 tiers, ~847 ceiling) so .limit(2000) — silently
  // clamped to 1,000 — is not truncating yet. It is still wrong to leave: the sort
  // is d ASCENDING, so the first overflow would drop the NEWEST days off a market
  // index chart while leaving stale history in place. Paged instead.
  const { rows: data, error } = await fetchAllPaged<Row>(
    (from, to) =>
      (supabaseAdmin as any)
        .from("topshot_market_index_daily")
        .select("d, tier, sales, volume_usd, median_px, avg_px, max_px")
        .gte("d", cutoff)
        .order("d", { ascending: true })
        .order("tier", { ascending: true })
        .range(from, to),
    { label: "insights/market" },
  )
  if (error) {
    console.error("[insights/market] initial fetch", error)
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
