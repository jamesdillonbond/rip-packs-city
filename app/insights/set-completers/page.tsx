// app/insights/set-completers/page.tsx
//
// Public Set Completers — SERVER component. Fetches the rookie-set completion
// board server-side from get_topshot_set_completers() (backed by the Dune
// ownership index) and hands it to the client layer as `initialBoard`, so the
// per-set completer counts land in the raw server HTML and are crawlable — the
// SEO thesis of this surface. Metadata + JSON-LD live in layout.tsx.

import SetCompletersBoardClient from "./SetCompletersBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import {
  fetchSetCompletersBoard,
  EMPTY_BOARD,
  type SetCompletersBoard,
} from "@/lib/set-completers-board"

// The MV refreshes daily; 15-min ISR matches the public route's edge cache.
export const revalidate = 900


export default async function SetCompletersPage() {
  const { data: board, fetchedAt, ok } = await fetchBoardForPage<SetCompletersBoard>(
    "Set completers",
    EMPTY_BOARD,
    (db) => fetchSetCompletersBoard(db),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Set completers", ok)])} />
      {/* ⚠ The banner above is NOT a substitute: without this the board states
          "No completion data available yet." as a fact, directly under a notice
          saying the data is degraded. Fix per PANEL, not per page. */}
      <SetCompletersBoardClient initialBoard={board} initialFetchedAt={fetchedAt} initialFailed={!ok} />
    </>
  )
}
