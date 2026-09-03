// app/insights/squeeze/page.tsx
//
// Public lock-rate squeeze board — SERVER component. Fetches the default-view
// rows (min_squeeze >= 50, squeeze desc) directly from the public
// `topshot_squeeze_board` view via supabaseAdmin, exactly as the
// /api/public/insights/squeeze route does, and hands them to the client
// interactivity layer as `initialRows`. This puts the ranked table AND the
// per-row entity drill-down links (/nba-top-shot/edition/<external_id>) into
// the raw server HTML so the unique content is crawlable — the entire SEO
// thesis of this surface. The client (SqueezeBoardClient) layers on
// filter/sort/drill-down as progressive enhancement and only refetches when
// the user changes the sort or arrives via a set/player drill-down.
//
// The single biggest "Top Shot's site won't tell you this" surface, per the
// 2026-05-29 research thread: nbatopshot.com shows nominal circulation; we
// show effective supply after locks and burns.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchSqueezeBoard } from "@/lib/insights/squeeze-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import SqueezeBoardClient, { type Row } from "./SqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge_editions refreshes hourly.
export const revalidate = 300

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the board rendered EMPTY at HTTP 200 — byte-identical
// to "no edition is 50%+ squeezed", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    // The QUERY is shared with the API route via lib/insights/squeeze-board.ts so
    // the two cannot drift; the limit and the 50% floor are the page's own default
    // view (the client refetches with its own explicit values).
    const { data, error } = await withBoardBudget(fetchSqueezeBoard({ limit: 200, minSqueeze: 50 }), "squeeze")
    if (error) {
      console.error("[insights/squeeze] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    // A BUDGET OVERRUN lands here, not in the `error` branch above:
    // withBoardBudget REJECTS, which is how a merely-SLOW read reaches the
    // same honest-degraded outcome a failed one already had.
    console.error("[insights/squeeze] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function SqueezePage() {
  const { rows, ok } = await fetchInitialRows()
  // ⚠ `initialFetchedAt` is NULL, not the render clock, when the read FAILED.
  // "Updated <now>" is a claim about the DATA's freshness built from OUR clock: on
  // a failed read it told the reader our numbers were current at the same moment
  // the board had none — the fabricated-freshness shape. FreshnessStamp renders
  // null as "—", whose documented meaning is exactly "no timestamp was supplied".
  // The DegradedDataNotice inside the board is NOT a substitute: a page with one
  // honest error branch is not an honest page.
  return (
    <SqueezeBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Squeeze board", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
    />
  )
}
