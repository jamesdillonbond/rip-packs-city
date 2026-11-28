// app/insights/whales/page.tsx
//
// Public Whale Watch — SERVER component. Reads the hourly precomputed board
// server-side and hands it to the client layer as `initialBoard`, so the leaders,
// big moves and biggest buys are in the raw server HTML (crawlable). The 7d / 30d
// toggle selects an already-loaded window — no refetch. Metadata + JSON-LD live in
// layout.tsx.

import WhalesBoardClient from "./WhalesBoardClient"
import DegradedDataNotice from "@/components/insights/DegradedDataNotice"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { fetchWhaleWatchBoard, EMPTY_WHALE_BOARD, type WhaleWatchBoard } from "@/lib/whale-watch-board"

// The board is rewritten hourly; 15-min ISR matches the public route's edge cache.
export const revalidate = 900

export default async function WhalesPage() {
  const { data: board, fetchedAt, ok } = await fetchBoardForPage<WhaleWatchBoard>(
    "Whale Watch",
    EMPTY_WHALE_BOARD,
    (db) => fetchWhaleWatchBoard(db),
  )
  return (
    <>
      <DegradedDataNotice summary={summarizeDegraded([boardStatus("Whale Watch", ok)])} />
      <WhalesBoardClient initialBoard={board} initialFetchedAt={ok ? fetchedAt : null} initialFailed={!ok} />
    </>
  )
}
