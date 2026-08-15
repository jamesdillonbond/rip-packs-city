// app/insights/pinnacle-scarcity/page.tsx
//
// Public Pinnacle Scarcity Board — SERVER component. Fetches the default-view
// rows (scarcity desc) directly from the public pinnacle_scarcity_board view
// via supabaseAdmin (exactly as /api/public/insights/pinnacle-scarcity does)
// and hands them to the client interactivity layer as `initialRows`. This puts
// the ranked table AND the per-row /pinnacle/moment/<id> drill-down links into
// the raw server HTML so the unique scarcity content is crawlable. The client
// (PinnacleScarcityBoardClient) layers on franchise/chasers/sort filters as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchPinnacleScarcityBoard } from "@/lib/insights/pinnacle-scarcity-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import PinnacleScarcityBoardClient, { type Row } from "./PinnacleScarcityBoardClient"

// Match the API route's 30-minute edge cache (pinnacle_editions changes slowly).
export const revalidate = 1800

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the table rendered EMPTY at HTTP 200 — byte-identical
// to "no Pin is scarcer than its variant", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    // The QUERY is shared with the API route via
    // lib/insights/pinnacle-scarcity-board.ts so the two cannot drift; the limit is
    // the page's own default view.
    const { data, error } = await withBoardBudget(fetchPinnacleScarcityBoard({ limit: 100 }), "pinnacle-scarcity")
    if (error) {
      console.error("[insights/pinnacle-scarcity] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    // A BUDGET OVERRUN lands here, not in the `error` branch above:
    // withBoardBudget REJECTS, which is how a merely-SLOW read reaches the
    // same honest-degraded outcome a failed one already had.
    console.error("[insights/pinnacle-scarcity] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function PinnacleScarcityPage() {
  const { rows, ok } = await fetchInitialRows()
  return (
    <PinnacleScarcityBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Scarcity board", ok)])}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
