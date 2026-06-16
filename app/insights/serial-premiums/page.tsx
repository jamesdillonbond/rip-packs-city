// app/insights/serial-premiums/page.tsx
//
// Public Serial Premiums (#1 Watch) — SERVER component. Fetches the default-view
// rows (all tiers, last 90d, premium desc) directly from the public
// topshot_serial_premiums_board view — exactly the default the
// /api/public/insights/serial-premiums route serves — and hands them to the
// client interactivity layer as `initialRows`. This puts the ranked board AND
// the per-row drill-down links into the raw server HTML so the unique content
// (the extreme #1 premiums + player/set/multiple) is crawlable — the SEO thesis
// of this surface.
//
// The client (SerialPremiumsBoardClient) layers tier + window + sort filters on
// top as progressive enhancement and only refetches when the user changes them.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import SerialPremiumsBoardClient, { type Row } from "./SerialPremiumsBoardClient"
import { supabaseAdmin } from "@/lib/supabase"

// The backing view reads sales live; 15-min ISR matches the route's edge cache.
export const revalidate = 900

const SELECT_COLS =
  "edition_id, external_id, player_name, set_name, tier, circulation_count, thumbnail_url, moment_id, nft_id, edition_median_usd, no1_last_sale_usd, premium_multiple, no1_sold_at, edition_sales_180d"

async function fetchInitialRows(): Promise<{ rows: Row[]; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const sinceIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const { data, error } = await (supabaseAdmin as any)
      .from("topshot_serial_premiums_board")
      .select(SELECT_COLS)
      .gte("premium_multiple", 5)
      .gte("no1_sold_at", sinceIso)
      .order("premium_multiple", { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    return { rows: (data ?? []) as Row[], fetchedAt }
  } catch (e) {
    console.error("[insights/serial-premiums] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], fetchedAt }
  }
}

export default async function SerialPremiumsPage() {
  const { rows, fetchedAt } = await fetchInitialRows()
  return <SerialPremiumsBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
}
