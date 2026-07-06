// app/insights/set-completers/page.tsx
//
// Public Set Completers — SERVER component. Fetches the rookie-set completion
// board server-side from get_topshot_set_completers() (backed by the Dune
// ownership index) and hands it to the client layer as `initialBoard`, so the
// per-set completer counts land in the raw server HTML and are crawlable — the
// SEO thesis of this surface. Metadata + JSON-LD live in layout.tsx.

import SetCompletersBoardClient from "./SetCompletersBoardClient"
import { supabaseAdmin } from "@/lib/supabase"
import {
  fetchSetCompletersBoard,
  EMPTY_BOARD,
  type SetCompletersBoard,
} from "@/lib/set-completers-board"

// The MV refreshes daily; 15-min ISR matches the public route's edge cache.
export const revalidate = 900

async function fetchInitial(): Promise<{ board: SetCompletersBoard; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const board = await fetchSetCompletersBoard(supabaseAdmin)
    return { board, fetchedAt }
  } catch (e) {
    console.error("[insights/set-completers] initial fetch", e instanceof Error ? e.message : e)
    return { board: EMPTY_BOARD, fetchedAt }
  }
}

export default async function SetCompletersPage() {
  const { board, fetchedAt } = await fetchInitial()
  return <SetCompletersBoardClient initialBoard={board} initialFetchedAt={fetchedAt} />
}
