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

import { supabaseAdmin } from "@/lib/supabase"
import TrophiesBoardClient, { type Row } from "./TrophiesBoardClient"

// FMV recomputes on its own cron and trophies move slowly; 1-hour ISR.
export const revalidate = 3600

const SELECT_COLS =
  "edition_id, external_id, collection, collection_id, name, player_name, set_name, team_name, tier, series, circulation_count, thumbnail_url, video_url, is_one_of_one, is_ultimate, fmv_usd, confidence, fmv_computed_at"

async function fetchInitialRows(): Promise<Row[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("v_insights_trophies")
    .select(SELECT_COLS)
    .order("fmv_usd", { ascending: false, nullsFirst: false })
    .order("circulation_count", { ascending: true, nullsFirst: false })
    .limit(200)
  if (error) {
    console.error("[insights/trophies] initial fetch", error.message)
    return []
  }
  return (data ?? []) as Row[]
}

export default async function TrophiesPage() {
  const initialRows = await fetchInitialRows()
  return (
    <TrophiesBoardClient
      initialRows={initialRows}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
