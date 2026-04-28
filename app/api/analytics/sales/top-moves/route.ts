// GET /api/analytics/sales/top-moves
//
// Thin wrapper over analytics_sales_top_moves(p_start_at, p_end_at,
// p_collections, p_limit). Returns the largest single sales in the
// window, with edition/player/marketplace context already JOINed.
//
// Query params:
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all  (default all)
//   collections comma-separated list                         (optional)
//   limit       1..100                                       (default 20)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SalesTopMoveRow } from "@/lib/analytics-types"

export const revalidate = 600

function parseLimit(raw: string | null): number {
  const n = parseInt(raw || "20", 10)
  if (!Number.isFinite(n) || n <= 0) return 20
  return Math.min(100, n)
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const limit = parseLimit(url.searchParams.get("limit"))
    const range = windowRange(window)

    console.log(
      `[analytics/sales/top-moves] start window=${window} collections=${collections?.join(",") ?? "all"} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<SalesTopMoveRow[]>(
      supabaseAdmin,
      "analytics_sales_top_moves",
      {
        p_start_at: range.startISO,
        p_end_at: range.endISO,
        p_collections: collections,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/sales/top-moves] rpc_error", error.message)
      return NextResponse.json({ error: "top_moves_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as SalesTopMoveRow[]
    console.log(
      `[analytics/sales/top-moves] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/sales/top-moves] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "top_moves_failed" }, { status: 500 })
  }
}
