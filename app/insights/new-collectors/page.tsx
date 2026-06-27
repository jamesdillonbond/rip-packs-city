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
import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchNewCollectorsBoard,
  EMPTY_BOARD,
  type NewCollectorsBoard,
} from "@/lib/new-collectors-board"

// The MVs refresh daily; 15-min ISR matches the public route's edge cache.
export const revalidate = 900

async function fetchInitial(): Promise<{ board: NewCollectorsBoard; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const board = await fetchNewCollectorsBoard(supabaseAdmin)
    return { board, fetchedAt }
  } catch (e) {
    console.error("[insights/new-collectors] initial fetch", e instanceof Error ? e.message : e)
    return { board: EMPTY_BOARD, fetchedAt }
  }
}

export default async function NewCollectorsPage() {
  const { board, fetchedAt } = await fetchInitial()
  return <NewCollectorsBoardClient initialBoard={board} initialFetchedAt={fetchedAt} />
}
