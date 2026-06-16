// app/insights/serial-premiums/page.tsx
//
// Public Serial Premiums — SERVER component. Fetches the default-view rows (#1
// mint, all tiers, last 90d, premium desc) directly from the public
// topshot_serial_premiums_board view — exactly the default the
// /api/public/insights/serial-premiums route serves — and hands them to the
// client interactivity layer as `initialRows`. This puts the ranked board AND
// the per-row drill-down links into the raw server HTML so the unique content
// (the extreme #1 premiums + player/set/multiple) is crawlable — the SEO thesis
// of this surface.
//
// The client (SerialPremiumsBoardClient) layers the #1/perfect headline toggle +
// tier + window + sort filters on top as progressive enhancement and only
// refetches when the user changes them.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import SerialPremiumsBoardClient from "./SerialPremiumsBoardClient"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchSerialPremiums, type SerialBoardRow } from "@/lib/serial-premiums-board"

// The backing view reads sales live; 15-min ISR matches the route's edge cache.
export const revalidate = 900

async function fetchInitialRows(): Promise<{ rows: SerialBoardRow[]; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const rows = await fetchSerialPremiums(supabaseAdmin, {
      mode: "no1",
      tier: null,
      windowDays: 90,
      minPremium: 5,
      sort: "premium",
      limit: 100,
    })
    return { rows, fetchedAt }
  } catch (e) {
    console.error("[insights/serial-premiums] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], fetchedAt }
  }
}

export default async function SerialPremiumsPage() {
  const { rows, fetchedAt } = await fetchInitialRows()
  return <SerialPremiumsBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
}
