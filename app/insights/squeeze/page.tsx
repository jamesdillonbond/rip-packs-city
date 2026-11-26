// app/insights/squeeze/page.tsx
//
// Public lock-rate squeeze board — SERVER component. Serves the default-view
// rows (min_squeeze >= 50, squeeze desc, top 200) of the public
// `topshot_squeeze_board` view — the same query the
// /api/public/insights/squeeze route runs — and hands them to the client
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
// 2026-11-26: read through the board-cache ladder (board `squeeze`, warmed by
// /api/cron/refresh-insights-cache). Before, every 5-minute regeneration ran the
// full view live, and under IO pressure that read crossed the 8 s board budget
// 7 times in a week, each one cached as a "couldn't load" page for the whole
// revalidate window. Now: fresh snapshot → live read → last complete snapshot
// (with its own age) → only then the honest degraded state.
//
// Metadata + JSON-LD live in layout.tsx (server-rendered).

import { readBoardOrLive } from "@/lib/insights/board-cache"
import { degradedFromSource } from "@/lib/insights/board-status"
import { fetchSqueezeDefault } from "@/lib/insights/squeeze-board"
import SqueezeBoardClient, { type Row } from "./SqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge_editions refreshes hourly.
export const revalidate = 300

export default async function SqueezePage() {
  const { payload, source } = await readBoardOrLive("squeeze", () => fetchSqueezeDefault())
  // "live-degraded" = no live read AND no snapshot: the board failed. Its rows are
  // dropped rather than trusted, so an empty table can only mean a successful read.
  const failed = source === "live-degraded"
  const rows = failed ? [] : ((payload.rows as Row[] | undefined) ?? [])
  // ⚠ `initialFetchedAt` is the time the ROWS were read (a snapshot keeps its own),
  // and NULL when the read failed — never the render clock. "Updated <now>" on a
  // failed or cached read would be a claim about the data's freshness built from our
  // clock: the fabricated-freshness shape (R95). FreshnessStamp renders null as "—".
  const initialFetchedAt = failed ? null : ((payload.fetched_at as string | null | undefined) ?? null)
  return (
    <SqueezeBoardClient
      initialRows={rows}
      initialDegraded={degradedFromSource(source, "Squeeze board")}
      initialFetchedAt={initialFetchedAt}
    />
  )
}
