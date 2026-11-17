// app/insights/trophies/page.tsx
//
// Public Trophy Room — SERVER component. Fetches the default-view rows
// (all trophy classes, FMV desc nulls last) directly from the public
// `v_insights_trophies` view via supabaseAdmin, exactly as the
// /api/public/insights/trophies route does, and hands them to the client
// interactivity layer as `initialRows`. This puts the ranked trophy grid AND
// the per-tile entity drill-down links (/<collection>/edition/<external_id>)
// into the raw server HTML so the unique content is crawlable — the SEO
// thesis of this surface. The client (TrophiesBoardClient) layers on
// collection / type filters + sort as progressive enhancement and only
// refetches when the user changes them.
//
// The one grail surface Top Shot's own site won't frame as a cohort: every
// 1-of-1 + Ultimate-tier moment across Flow, ranked by FMV — the rarest
// things on the chain, in one place. Per the 2026-05-29 research thread,
// trophy-hunting was the gap the other public /insights surfaces left open.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { fetchTrophiesBoard } from "@/lib/insights/trophies-board"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import TrophiesBoardClient, { type Row } from "./TrophiesBoardClient"

// FMV recomputes on its own cron and trophies move slowly; 1-hour ISR.
export const revalidate = 3600

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the grid rendered EMPTY at HTTP 200 — byte-identical
// to "no trophies exist", i.e. a statement timeout rendered as a measurement.
// See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  try {
    // The QUERY is shared with the API route via lib/insights/trophies-board.ts so
    // the two cannot drift; the limit is the page's own default view.
    const { data, error } = await withBoardBudget(fetchTrophiesBoard({ limit: 200 }), "trophies")
    if (error) {
      console.error("[insights/trophies] initial fetch", error.message)
      return { rows: [], ok: false }
    }
    return { rows: (data ?? []) as Row[], ok: true }
  } catch (e) {
    // A BUDGET OVERRUN lands here, not in the `error` branch above:
    // withBoardBudget REJECTS, which is how a merely-SLOW read reaches the
    // same honest-degraded outcome a failed one already had.
    console.error("[insights/trophies] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], ok: false }
  }
}

export default async function TrophiesPage() {
  const { rows, ok } = await fetchInitialRows()
  // ⚠ `initialFetchedAt` is NULL, not the render clock, when the read FAILED.
  // "Updated <now>" is a claim about the DATA's freshness built from OUR clock: on
  // a failed read it told the reader our numbers were current at the same moment
  // the board had none — the fabricated-freshness shape. FreshnessStamp renders
  // null as "—", whose documented meaning is exactly "no timestamp was supplied".
  // The DegradedDataNotice inside the board is NOT a substitute: a page with one
  // honest error branch is not an honest page.
  return (
    <TrophiesBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Trophy Room", ok)])}
      initialFetchedAt={ok ? new Date().toISOString() : null}
    />
  )
}
