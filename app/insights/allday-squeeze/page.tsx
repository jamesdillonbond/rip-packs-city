// app/insights/allday-squeeze/page.tsx
//
// NFL All Day's lock-rate squeeze board — SERVER component. Same shape as
// /insights/squeeze: the default view (squeeze >= 50, squeeze desc) is read
// server-side from allday_squeeze_board through the shared fetchSqueezeBoard, so
// the ranked table and its /nfl-all-day/edition/<id> links are in the raw HTML.
// The client starts on All Day (`initialCollection`), so its seed and its toggle
// agree from the first paint.

import { fetchSqueezeBoard } from "@/lib/insights/squeeze-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import SqueezeBoardClient, { type Row } from "../squeeze/SqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge_editions refreshes hourly.
export const revalidate = 300

// `ok:false` on a failed or over-budget read, so the page says so instead of
// rendering an empty board that reads as "nothing is 50%+ squeezed".
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    const { data, error } = await withBoardBudget(
      fetchSqueezeBoard({ collection: "nfl-all-day", limit: 200, minSqueeze: 50 }),
      "allday-squeeze",
    )
    if (error) {
      console.error("[insights/allday-squeeze] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    console.error("[insights/allday-squeeze] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function AllDaySqueezePage() {
  const { rows, ok } = await fetchInitialRows()
  // A failed read stamps NULL ("—"), never the render clock (see /insights/squeeze).
  return (
    <SqueezeBoardClient
      initialRows={rows}
      initialCollection="nfl-all-day"
      initialDegraded={summarizeDegraded([boardStatus("Squeeze board", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
    />
  )
}
