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

import { supabaseAdmin } from "@/lib/supabase"
import { boardStatus, summarizeDegraded } from "@/lib/insights/board-status"
import SqueezeBoardClient, { type Row } from "./SqueezeBoardClient"

// Match the API route's 5-minute edge cache; badge_editions refreshes hourly.
export const revalidate = 300

const SELECT_COLS =
  "edition_id, external_id, player_name, set_name, tier, circulation, locked, burned, lock_pct, burn_pct, squeeze_pct, effectively_buyable, low_ask, low_ask_disconnected, fmv_usd, confidence, game_date, thumbnail_url"

// Returns `ok:false` on a failed read so the page can say so. Before this the
// error path returned [] and the board rendered EMPTY at HTTP 200 — byte-identical
// to "no edition is 50%+ squeezed", i.e. a statement timeout rendered as a
// measurement. See lib/insights/board-status.ts.
async function fetchInitialRows(): Promise<{ rows: Row[]; ok: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data, error } = await (supabaseAdmin as any)
    .from("topshot_squeeze_board")
    .select(SELECT_COLS)
    .gte("squeeze_pct", 50)
    .order("squeeze_pct", { ascending: false })
    .order("circulation", { ascending: true })
    .limit(200)
  if (error) {
    console.error("[insights/squeeze] initial fetch", error.message)
    return { rows: [], ok: false }
  }
  return { rows: (data ?? []) as Row[], ok: true }
}

export default async function SqueezePage() {
  const { rows, ok } = await fetchInitialRows()
  return (
    <SqueezeBoardClient
      initialRows={rows}
      initialDegraded={summarizeDegraded([boardStatus("Squeeze board", ok)])}
      initialFetchedAt={new Date().toISOString()}
    />
  )
}
