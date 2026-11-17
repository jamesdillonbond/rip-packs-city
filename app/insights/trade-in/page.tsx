// app/insights/trade-in/page.tsx
//
// Public Top Shot This trade-in finder — SERVER component. Reads the default view
// (cheapest pack first, across every player) from v_insights_trade_in and hands it
// to the client as initialRows, so the editions and their drill-down links are in
// the raw server HTML. The client layers the player search, the sort tabs and the
// "what does my wallet count for" arm.
//
// Metadata + JSON-LD live in layout.tsx.

import TradeInBoardClient from "./TradeInBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchTradeInBoard, type TradeInRow } from "@/lib/insights/trade-in-board"

// Top Shot's figures refresh about daily; one hour matches the route's edge cache.
export const revalidate = 3600

export default async function TradeInPage() {
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<TradeInRow[]>(
    "Trade-In Finder",
    [],
    async (db) => {
      const r = await fetchTradeInBoard(db, { sort: "cost", limit: 100 })
      // A failed read must reach the degraded branch, never render as "no editions".
      if (r.error || !r.data) throw new Error(r.error?.message ?? "trade-in board read failed")
      return r.data
    },
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Trade-In Finder", ok)])} />
      <TradeInBoardClient initialRows={rows} initialFetchedAt={ok ? fetchedAt : null} initialFailed={!ok} />
    </>
  )
}
