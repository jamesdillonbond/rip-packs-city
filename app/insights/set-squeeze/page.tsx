// app/insights/set-squeeze/page.tsx
//
// Public Set Squeeze Leaderboard — SERVER component. Fetches the default-view
// rows (avg_squeeze desc) directly from the public topshot_set_squeeze_board
// view via supabaseAdmin (exactly as /api/public/insights/set-squeeze does)
// and hands them to the client interactivity layer as `initialRows`. This puts
// the ranked table AND the per-row /nba-top-shot/set/<slug> drill-down links
// into the raw server HTML so the unique set-level squeeze content is
// crawlable. The client (SetSqueezeBoardClient) layers on series/tier/sort
// filters as progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchSetSqueezeBoard } from "@/lib/insights/set-squeeze-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import SetSqueezeBoardClient, { type Row } from "./SetSqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge data refreshes hourly.
export const revalidate = 300

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the leaderboard rendered EMPTY at HTTP 200 —
// byte-identical to "no set qualifies", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    // The QUERY is shared with the API route via lib/insights/set-squeeze-board.ts
    // so the two cannot drift; the limit is the page's own default view.
    const { data, error } = await withBoardBudget(fetchSetSqueezeBoard({ limit: 100 }), "set-squeeze")
    if (error) {
      console.error("[insights/set-squeeze] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    // A BUDGET OVERRUN lands here, not in the `error` branch above:
    // withBoardBudget REJECTS, which is how a merely-SLOW read reaches the
    // same honest-degraded outcome a failed one already had.
    console.error("[insights/set-squeeze] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function SetSqueezePage() {
  const { rows, ok } = await fetchInitialRows()
  // ⚠ `initialFetchedAt` is NULL, not the render clock, when the read FAILED.
  // "Updated <now>" is a claim about the DATA's freshness built from OUR clock: on
  // a failed read it told the reader our numbers were current at the same moment
  // the board had none — the fabricated-freshness shape. FreshnessStamp renders
  // null as "—", whose documented meaning is exactly "no timestamp was supplied".
  // The DegradedDataNotice inside the board is NOT a substitute: a page with one
  // honest error branch is not an honest page.
  return (
    <SetSqueezeBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Set squeeze leaderboard", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
    />
  )
}
