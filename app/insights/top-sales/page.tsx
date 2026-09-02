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
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchTopSales } from "@/lib/insights/top-sales"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

// Sales move faster than trophies; 15-min ISR matches the route's edge cache.
export const revalidate = 900

async function fetchInitialRows(): Promise<{ rows: Row[]; fetchedAt: string; ok: boolean }> {
  try {
    const { rows, fetchedAt } = await withBoardBudget(
      fetchTopSales({ collection: null, window: "7d", sort: "price", limit: 100 }),
      "top-sales",
    )
    return { rows: rows as Row[], fetchedAt, ok: true }
  } catch (e) {
    console.error("[insights/top-sales] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], fetchedAt: new Date().toISOString(), ok: false }
  }
}

export default async function TopSalesPage() {
  const { rows, fetchedAt, ok } = await fetchInitialRows()
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Top sales", ok)])} />
      {/*
        ⚠ `initialFailed` is the FIFTH honesty layer, and the banner above is NOT a
        substitute for it — the 2026-08-24 sweep that fixed five boards records that
        all five already had one. `fetchBoardForPage` returns `[]` on a failed read,
        and that arrives below carrying NO PROVENANCE.
        ⚠ This client's own header says "the default view never refetches on mount",
        so "No sales match those filters." stands until the reader changes a filter.
      */}
      <TopSalesBoardClient initialRows={rows} initialFetchedAt={fetchedAt} initialFailed={!ok} />
    </>
  )
}
