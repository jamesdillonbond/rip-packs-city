// app/api/public/insights/autographs/route.ts
//
// PUBLIC INSIGHTS — Autographs. Every SIGNED NBA Top Shot / NFL All Day edition
// (editions.autographed_at, from Atlas) with its lowest live ask, 90-day sales,
// last sale, and the unsigned printing of the same Moment. Backed by
// v_insights_autographs (security_invoker = on, anon-granted). No FMV or
// confidence by design — see lib/insights/autographs-board.ts.
//
// Lives under /api/public/* so proxy.ts lets it through with no auth.
//
// Query params:
//   collection=nba_top_shot|nfl_all_day   default nba_top_shot
//   sort=listed|premium|recent|scarcity   default listed (cheapest live ask first)
//   listed=1                              only editions with a live ask (implied by sort=listed)
//   limit=<1..500>                        default 200
//
// Response: { meta: {...}, rows: [...] }. CACHE: 1-hour s-maxage.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { boardRowMeta } from "@/lib/insights/board-meta"
import {
  AUTOGRAPH_BOARD_COLLECTIONS,
  AUTOGRAPH_BOARD_SORTS,
  fetchAutographsBoard,
  type AutographBoardCollection,
  type AutographBoardSort,
} from "@/lib/insights/autographs-board"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const collectionRaw = sp.get("collection")?.trim() || "nba_top_shot"
  // An unknown collection is refused, never answered with another collection's rows.
  if (!(AUTOGRAPH_BOARD_COLLECTIONS as readonly string[]).includes(collectionRaw)) {
    return NextResponse.json(
      { error: "unsupported collection", supported: AUTOGRAPH_BOARD_COLLECTIONS },
      { status: 400 },
    )
  }
  const collection = collectionRaw as AutographBoardCollection

  const sortRaw = sp.get("sort")?.trim().toLowerCase() || "listed"
  const sort: AutographBoardSort = (AUTOGRAPH_BOARD_SORTS as readonly string[]).includes(sortRaw)
    ? (sortRaw as AutographBoardSort)
    : "listed"
  const listedOnly = sp.get("listed") === "1"
  const limit = Math.max(1, Math.min(500, Number(sp.get("limit")) || 200))

  let result
  try {
    result = await fetchAutographsBoard(supabase as never, { collection, sort, listedOnly, limit })
  } catch (e) {
    return boardUnavailable(e, "insights/autographs")
  }
  if (result.error || !result.data) return boardUnavailable(result.error, "insights/autographs")
  const rows = result.data

  const elapsedMs = Date.now() - startedAt
  console.log(`[public/insights/autographs] returned=${rows.length} collection=${collection} sort=${sort} elapsedMs=${elapsedMs}`)

  const res = NextResponse.json({
    meta: {
      fetched_at: new Date().toISOString(),
      source: "v_insights_autographs",
      ...boardRowMeta(rows.length, limit),
      elapsed_ms: elapsedMs,
      filters: { collection, sort, listed: listedOnly || sort === "listed", limit },
    },
    rows,
  })
  res.headers.set("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=300")
  return res
}
