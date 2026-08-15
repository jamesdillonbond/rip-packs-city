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
import TrophiesBoardClient, { type Row } from "./TrophiesBoardClient"

// FMV recomputes on its own cron and trophies move slowly; 1-hour ISR.
export const revalidate = 3600

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the grid rendered EMPTY at HTTP 200 — byte-identical
// to "no trophies exist", i.e. a statement timeout rendered as a measurement.
// See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  // The QUERY is shared with the API route via lib/insights/trophies-board.ts so
  // the two cannot drift; the limit is the page's own default view.
  const { data, error } = await fetchTrophiesBoard({ limit: 200 })
  if (error) {
    console.error("[insights/trophies] initial fetch", error.message)
    return { rows: [], ok: false }
  }
  return { rows: (data ?? []) as Row[], ok: true }
}

export default async function TrophiesPage() {
  const { rows, ok } = await fetchInitialRows()
  return (
    <TrophiesBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Trophy Room", ok)])}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
