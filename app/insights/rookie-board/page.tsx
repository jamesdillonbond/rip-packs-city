// app/insights/rookie-board/page.tsx
//
// Server component for the public Rookie Edition Board. Fetches the whole board
// (~431 rows) once and passes it to the client, so the grouped per-parallel
// tables + drill-down links render in the raw server HTML (crawlable — the SEO
// thesis). The client layers grouping, mode/tier/parallel filters, and the burn-
// rankings view on top without refetching (the dataset is small enough to filter
// in-memory).
//
// The differentiator vs the rookie-tracker competitor: per-PARALLEL FMV with a
// confidence tag (Standard $389 HIGH · Hexwave $672 MEDIUM · Jukebox $1,794 LOW),
// not one blended average per moment.

import RookieBoardClient from "./RookieBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchRookieEditionBoard, type RookieEditionRow } from "@/lib/rookie-edition-board"

export const revalidate = 900


export default async function RookieBoardPage() {
  const { data: rows, fetchedAt, ok } = await fetchBoardForPage<RookieEditionRow[]>(
    "Rookie board",
    [],
    (db) => fetchRookieEditionBoard(db, {
      mode: "board",
      tier: null,
      parallelId: null,
      player: null,
      set: null,
      sort: "fmv",
      limit: 500,
    }),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Rookie board", ok)])} />
      <RookieBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
    </>
  )
}
