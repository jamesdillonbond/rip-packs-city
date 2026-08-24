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
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchSerialPremiums, type SerialBoardRow } from "@/lib/serial-premiums-board"

// The backing view reads sales live; 15-min ISR matches the route's edge cache.
export const revalidate = 900


export default async function SerialPremiumsPage() {
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<SerialBoardRow[]>(
    "Serial premiums",
    [],
    (db) => fetchSerialPremiums(db, {
      mode: "no1",
      tier: null,
      windowDays: 90,
      minPremium: 5,
      sort: "premium",
      limit: 100,
    }),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Serial premiums", ok)])} />
      {/* ⚠ The banner above is NOT a substitute: without this the board states
          "No qualifying … sales in this window." as a fact about the window.
          Fix per PANEL, not per page. */}
      <SerialPremiumsBoardClient initialRows={rows} initialFetchedAt={fetchedAt} initialFailed={!ok} />
    </>
  )
}
