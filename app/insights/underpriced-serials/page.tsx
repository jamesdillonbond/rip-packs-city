// app/insights/underpriced-serials/page.tsx
//
// Public Underpriced #1s & Perfect Mints — SERVER component. Fetches the
// default-view rows (all headline serials, all tiers, discount desc) directly
// from the public topshot_underpriced_serials_board view — exactly the default
// the /api/public/insights/underpriced-serials route serves — and hands them to
// the client interactivity layer as `initialRows`. This puts the ranked board
// AND the per-row drill-down + buy links into the raw server HTML so the unique
// content (the live underpriced serials) is crawlable — the SEO thesis.
//
// The client (UnderpricedSerialsBoardClient) layers the headline / tier /
// quality / sort filters on top as progressive enhancement and only refetches
// when the user changes them.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import UnderpricedSerialsBoardClient from "./UnderpricedSerialsBoardClient"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchUnderpricedSerials, type UnderpricedRow } from "@/lib/underpriced-serials-board"

// The backing view reads the serial-FMV estimate live; 15-min ISR matches the
// route's edge cache. The listings spine refreshes on the ingest's cadence.
export const revalidate = 900

async function fetchInitialRows(): Promise<{ rows: UnderpricedRow[]; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const rows = await fetchUnderpricedSerials(supabaseAdmin, {
      headline: "all",
      tier: null,
      quality: "all",
      minDiscount: 0,
      sort: "discount",
      limit: 100,
    })
    return { rows, fetchedAt }
  } catch (e) {
    console.error("[insights/underpriced-serials] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], fetchedAt }
  }
}

export default async function UnderpricedSerialsPage() {
  const { rows, fetchedAt } = await fetchInitialRows()
  return <UnderpricedSerialsBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
}
