// app/insights/new-collectors/page.tsx
//
// Public New Collectors — SERVER component. Fetches the full board (all three
// windows + the cohort series) server-side from the four anon-granted MVs and
// hands it to the client interactivity layer as `initialBoard`. This puts the
// acquisition headline, spend mix, gateway sets/players (with their drill-down
// links into the entity hubs), and the full cohort table into the raw server
// HTML so the unique content is crawlable — the SEO thesis of this surface.
//
// The whole board arrives in one fetch, so the client window toggle just selects
// the already-loaded window locally — no refetch. Metadata + JSON-LD live in
// layout.tsx (server-rendered).

import NewCollectorsBoardClient from "./NewCollectorsBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import {
  fetchNewCollectorsBoard,
  EMPTY_BOARD,
  type NewCollectorsBoard,
} from "@/lib/new-collectors-board"

// The MVs refresh daily; 15-min ISR matches the public route's edge cache.
export const revalidate = 900


export default async function NewCollectorsPage() {
  const { data: board, fetchedAt, ok } = await fetchBoardForPage<NewCollectorsBoard>(
    "New collectors",
    EMPTY_BOARD,
    (db) => fetchNewCollectorsBoard(db),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("New collectors", ok)])} />
      {/*
        ⚠ Same fifth-layer gap as pack-drops, and worse here: this client has NO
        refetch at all ("the already-loaded window locally — no refetch"), so on a
        failed read the gateway panels state "No data in this window." to every
        viewer, permanently, with no way back. EMPTY_BOARD is the fallback and it
        carries no provenance.
      */}
      <NewCollectorsBoardClient initialBoard={board} initialFetchedAt={fetchedAt} initialFailed={!ok} />
    </>
  )
}
