// app/insights/autographs/page.tsx
//
// Public Autographs board — SERVER component. Reads the default view (NBA Top
// Shot, cheapest live ask first) from v_insights_autographs and hands it to the
// client as initialRows, so the signed editions and their drill-down links are
// in the raw server HTML. The client layers the collection / sort tabs.
//
// Metadata + JSON-LD live in layout.tsx.

import AutographsBoardClient from "./AutographsBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchAutographsBoard, type AutographRow } from "@/lib/insights/autographs-board"

// The view reads live asks and sales; one hour matches the route's edge cache.
export const revalidate = 3600

export default async function AutographsPage() {
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<AutographRow[]>(
    "Autographs",
    [],
    async (db) => {
      const r = await fetchAutographsBoard(db, { collection: "nba_top_shot", sort: "listed", limit: 200 })
      // A failed read must reach the degraded branch, never render as "no signed editions".
      if (r.error || !r.data) throw new Error(r.error?.message ?? "autographs board read failed")
      return r.data
    },
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Autographs", ok)])} />
      <AutographsBoardClient initialRows={rows} initialFetchedAt={ok ? fetchedAt : null} initialFailed={!ok} />
    </>
  )
}
