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

import { fetchMarketIndexPageRows } from "@/lib/insights/market-index-board"
import MarketIndexClient from "./MarketIndexClient"

// Match the API route's 15-minute edge cache (daily-granularity data).
export const revalidate = 900

export default async function MarketIndexPage() {
  const { rows, loadError } = await fetchMarketIndexPageRows("nba-top-shot")
  // ⚠ `initialFetchedAt` is NULL, not the render clock, when the read FAILED.
  // "Updated <now>" is a claim about the DATA's freshness built from OUR clock: on
  // a failed read it told the reader our numbers were current at the same moment
  // the board had none — the fabricated-freshness shape. FreshnessStamp renders
  // null as "—", whose documented meaning is exactly "no timestamp was supplied".
  // The DegradedDataNotice inside the board is NOT a substitute: a page with one
  // honest error branch is not an honest page.
  return (
    <MarketIndexClient
      initialRows={rows}
      initialFetchedAt={!loadError ? new Date().toISOString() : null}
      loadError={loadError}
      collection="nba-top-shot"
    />
  )
}
