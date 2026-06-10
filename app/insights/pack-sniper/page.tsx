// app/insights/pack-sniper/page.tsx
//
// Public Pack Sniper deal board — SERVER component. Fetches the default view
// (Top Shot, honest deals only — high-variance lottery packs hidden) via the
// shared getPackDeals() helper and hands them to the client interactivity layer
// as initialDeals. This puts the ranked table AND the per-row drill-down links
// (/<collection>/pack/dist/<distId>) into the raw server HTML so the unique
// content is crawlable. The client (PackSniperClient) layers on the collection
// toggle, the show/hide-high-variance toggle, and refetch.
//
// RANK, DON'T PRICE — see lib/packs/pack-deals.ts for the honesty rationale.
// Metadata + JSON-LD live in layout.tsx.

import { getPackDeals, type PackDeal } from "@/lib/packs/pack-deals"
import PackSniperClient from "./PackSniperClient"

// Live Dapper Studio fetch is memoized 2m; the API CDN-caches 5m. Match here.
export const revalidate = 300

async function fetchInitial(): Promise<{ deals: PackDeal[]; fetchedAt: string }> {
  try {
    // Default crawlable view: Top Shot, honest deals only (lottery packs hidden).
    const res = await getPackDeals("nba-top-shot", { limit: 100, includeHighVariance: false })
    return { deals: res.deals, fetchedAt: new Date().toISOString() }
  } catch (e) {
    console.error("[insights/pack-sniper] initial fetch", e instanceof Error ? e.message : e)
    return { deals: [], fetchedAt: new Date().toISOString() }
  }
}

export default async function PackSniperPage() {
  const { deals, fetchedAt } = await fetchInitial()
  return <PackSniperClient initialDeals={deals} initialFetchedAt={fetchedAt} />
}
