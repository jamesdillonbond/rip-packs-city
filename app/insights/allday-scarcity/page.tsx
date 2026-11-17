// app/insights/allday-scarcity/page.tsx
//
// Public NFL All Day Scarcity Board — SERVER component. Fetches the default-view
// rows (scarcity desc, statistically-meaningful cohort) directly from the public
// allday_scarcity_board view through lib/insights/allday-scarcity-board.ts —
// the SAME query object the API route builds, so "exactly as the API route
// does" is now enforced rather than asserted in a comment
// and hands them to the client interactivity layer as `initialRows`. This puts
// the ranked table AND the per-row /nfl-all-day/edition/<external_id> drill-down
// links into the raw server HTML so the unique scarcity content is crawlable.
// The client (AllDayScarcityBoardClient) layers on tier/sort filters as
// progressive enhancement and only refetches when those change.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchAllDayScarcityBoard } from "@/lib/insights/allday-scarcity-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import AllDayScarcityBoardClient, { type Row } from "./AllDayScarcityBoardClient"

// Match the API route's 30-minute edge cache (editions change slowly).
export const revalidate = 1800

// Default board view: the honest "scarce" cohort — families with >= 3 members
// (so the average mean means something) and only editions actually scarcer than
// their family. The QUERY is shared with the API route via
// lib/insights/allday-scarcity-board.ts so the two cannot drift; the limit is
// the page's own — the client refetches with an explicit limit=100, and the
// route's default of 50 is for direct API callers.
//
// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the table rendered EMPTY at HTTP 200 — byte-identical
// to "no edition is scarcer than its family", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    const { data, error } = await withBoardBudget(fetchAllDayScarcityBoard({ limit: 100 }), "allday-scarcity")
    if (error) {
      console.error("[insights/allday-scarcity] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    // A BUDGET OVERRUN lands here, not in the `error` branch above:
    // withBoardBudget REJECTS, which is how a merely-SLOW read reaches the
    // same honest-degraded outcome a failed one already had.
    console.error("[insights/allday-scarcity] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function AllDayScarcityPage() {
  const { rows, ok } = await fetchInitialRows()
  // ⚠ `initialFetchedAt` is NULL, not the render clock, when the read FAILED.
  // "Updated <now>" is a claim about the DATA's freshness built from OUR clock: on
  // a failed read it told the reader our numbers were current at the same moment
  // the board had none — the fabricated-freshness shape. FreshnessStamp renders
  // null as "—", whose documented meaning is exactly "no timestamp was supplied".
  // The DegradedDataNotice inside the board is NOT a substitute: a page with one
  // honest error branch is not an honest page.
  return (
    <AllDayScarcityBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Scarcity board", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
    />
  )
}
