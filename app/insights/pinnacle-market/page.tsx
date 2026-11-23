// app/insights/pinnacle-market/page.tsx
//
// The RPC Index for Disney Pinnacle (2026-11-23) — SERVER component. Same shape as /insights/market: the trailing-120-day
// rows are read server-side from pinnacle_market_index_daily through the shared fetchMarketIndexPageRows, so the
// per-tier cards, the index chart and the volume bars are in the raw HTML. The shared client renders Pinnacle's
// edition-type tiers (Limited / Open; Legendary counted, not plotted) and copy from `collection`.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchMarketIndexPageRows } from "@/lib/insights/market-index-board"
import MarketIndexClient from "../market/MarketIndexClient"

// Match the API route's 15-minute edge cache (daily-granularity data).
export const revalidate = 900

export default async function PinnacleMarketIndexPage() {
  const { rows, loadError } = await fetchMarketIndexPageRows("disney-pinnacle")
  // A failed read stamps NULL ("—"), never the render clock (see /insights/market).
  return (
    <MarketIndexClient
      initialRows={rows}
      initialFetchedAt={!loadError ? new Date().toISOString() : null}
      loadError={loadError}
      collection="disney-pinnacle"
    />
  )
}
