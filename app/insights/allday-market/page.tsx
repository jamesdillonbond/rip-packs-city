// app/insights/allday-market/page.tsx
//
// The RPC Index for NFL All Day (2026-10-28) — SERVER component. Same shape as /insights/market: the trailing-120-day
// rows are read server-side from allday_market_index_daily through the shared fetchMarketIndexPageRows, so the
// per-tier cards, the index chart and the volume bars are in the raw HTML. The shared client renders All Day's
// tiers (Legendary / Rare / Uncommon / Common) and copy from `collection`.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchMarketIndexPageRows } from "@/lib/insights/market-index-board"
import MarketIndexClient from "../market/MarketIndexClient"

// Match the API route's 15-minute edge cache (daily-granularity data).
export const revalidate = 900

export default async function AllDayMarketIndexPage() {
  const { rows, loadError } = await fetchMarketIndexPageRows("nfl-all-day")
  // A failed read stamps NULL ("—"), never the render clock (see /insights/market).
  return (
    <MarketIndexClient
      initialRows={rows}
      initialFetchedAt={!loadError ? new Date().toISOString() : null}
      loadError={loadError}
      collection="nfl-all-day"
    />
  )
}
