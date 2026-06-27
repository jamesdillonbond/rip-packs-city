// app/insights/rookie-board/page.tsx
//
// Server component for the public Rookie Edition Board. Fetches the whole board
// (~431 rows) once and passes it to the client, so the grouped per-parallel
// tables + drill-down links render in the raw server HTML (crawlable — the SEO
// thesis). The client layers grouping, mode/tier/parallel filters, and the burn-
// rankings view on top without refetching (the dataset is small enough to filter
// in-memory).
//
// The differentiator vs the rookie-tracker competitor: per-PARALLEL FMV with a
// confidence tag (Standard $389 HIGH · Hexwave $672 MEDIUM · Jukebox $1,794 LOW),
// not one blended average per moment.

import RookieBoardClient from "./RookieBoardClient"
import { supabaseAdmin } from "@/lib/supabase"
import { fetchRookieEditionBoard, type RookieEditionRow } from "@/lib/rookie-edition-board"

export const revalidate = 900

async function fetchInitialRows(): Promise<{ rows: RookieEditionRow[]; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString()
  try {
    const rows = await fetchRookieEditionBoard(supabaseAdmin, {
      mode: "board",
      tier: null,
      parallelId: null,
      player: null,
      set: null,
      sort: "fmv",
      limit: 500,
    })
    return { rows, fetchedAt }
  } catch (e) {
    console.error("[insights/rookie-board] initial fetch", e instanceof Error ? e.message : e)
    return { rows: [], fetchedAt }
  }
}

export default async function RookieBoardPage() {
  const { rows, fetchedAt } = await fetchInitialRows()
  return <RookieBoardClient initialRows={rows} initialFetchedAt={fetchedAt} />
}
