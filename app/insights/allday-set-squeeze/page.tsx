// app/insights/allday-set-squeeze/page.tsx
//
// NFL All Day's set squeeze leaderboard — SERVER component. Same shape as
// /insights/set-squeeze: the default view (avg squeeze desc) is read server-side
// from allday_set_squeeze_board through the shared fetchSetSqueezeBoard, so the
// ranked table and its All Day set links are in the raw HTML. The client starts
// on All Day (`initialCollection`), so its seed and its toggle agree from the
// first paint.

import { fetchSetSqueezeBoard } from "@/lib/insights/set-squeeze-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import SetSqueezeBoardClient, { type Row } from "../set-squeeze/SetSqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge data refreshes hourly.
export const revalidate = 300

// `ok:false` on a failed or over-budget read, so the page says so instead of
// rendering an empty leaderboard that reads as "no set qualifies".
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    const { data, error } = await withBoardBudget(
      fetchSetSqueezeBoard({ collection: "nfl-all-day", limit: 100 }),
      "allday-set-squeeze",
    )
    if (error) {
      console.error("[insights/allday-set-squeeze] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    console.error("[insights/allday-set-squeeze] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function AllDaySetSqueezePage() {
  const { rows, ok } = await fetchInitialRows()
  // A failed read stamps NULL ("—"), never the render clock (see /insights/set-squeeze).
  return (
    <SetSqueezeBoardClient
      initialRows={rows}
      initialCollection="nfl-all-day"
      initialDegraded={summarizeDegraded([boardStatus("Set squeeze leaderboard", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
    />
  )
}
