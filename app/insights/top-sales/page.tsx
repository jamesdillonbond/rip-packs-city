// app/insights/top-sales/page.tsx
//
// Public Top Sales / Whale Watch — SERVER component. Fetches the default-view
// rows (all collections, last 7d, price desc) with buyer/seller @handles
// already resolved via the shared lib/insights/top-sales helper — exactly as
// the /api/public/insights/top-sales route does — and hands them to the client
// interactivity layer as `initialRows`. This puts the ranked board AND the
// per-row drill-down links + resolved @handles into the raw server HTML so the
// unique content is crawlable (the SEO thesis of this surface), and the
// who-bought/who-sold differentiator renders without JS.
//
// The client (TopSalesBoardClient) layers collection + window + sort filters on
// top as progressive enhancement and only refetches when the user changes them.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import TopSalesBoardClient, { type Row } from "./TopSalesBoardClient"
import { fetchTopSales } from "@/lib/insights/top-sales"

// Sales move faster than trophies; 15-min ISR matches the route's edge cache.
export const revalidate = 900

async function fetchInitialRows(): Promise<{ rows: Row[]; fetchedAt: string }> {
  try {
    const { rows, fetchedAt } = await fetchTopSales({
      collection: null,
      window: "7d",
      sort: "price",
      limit: 100,
    })
    return { rows: rows as Row[], fetchedAt }
  } catch (e) {
    console.error("[insights/top-sales] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], fetchedAt: new Date().toISOString() }
  }
}

export default async function TopSalesPage() {
  const { rows, fetchedAt } = await fetchInitialRows()
  return <TopSalesBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
}
