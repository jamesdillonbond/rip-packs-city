// app/insights/allday-serial-premiums/page.tsx
//
// NFL All Day Serial Premiums (2026-10-28) — SERVER component. Same shape as /insights/serial-premiums: the default
// view (#1 mint, all tiers, 90 days, premium desc) is read server-side from allday_serial_premiums_board through the
// shared fetchSerialPremiums, so the ranked board and its /nfl-all-day drill-down links are in the raw HTML. The
// shared client starts on All Day (`collection`) and refetches only when a filter changes.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import SerialPremiumsBoardClient from "../serial-premiums/SerialPremiumsBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchSerialPremiums, type SerialBoardRow } from "@/lib/serial-premiums-board"

// The backing views read sales live; 15-min ISR matches the route's edge cache.
export const revalidate = 900

export default async function AllDaySerialPremiumsPage() {
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<SerialBoardRow[]>(
    "Serial premiums",
    [],
    (db) => fetchSerialPremiums(db, {
      mode: "no1",
      collection: "nfl-all-day",
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
      <SerialPremiumsBoardClient
        initialRows={rows}
        initialFetchedAt={ok ? fetchedAt : null}
        initialFailed={!ok}
        collection="nfl-all-day"
      />
    </>
  )
}
