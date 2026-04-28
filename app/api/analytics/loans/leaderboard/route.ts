// GET /api/analytics/loans/leaderboard
//
// Thin wrapper over flowty_analytics_leaderboard(p_role, p_start_at, p_end_at,
// p_collections, p_limit). Returns the RPC rows plus a resolved username
// map so the client can render display names without an extra round-trip.
//
// Query params:
//   role        lender | borrower                            (required)
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all   (default all)
//   collections comma-separated list                          (optional)
//   limit       1..100                                        (default 25)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/loans-window"
import { resolveUsernames, displayName } from "@/lib/flowty-username"
import type { AnalyticsLeaderboardRow } from "@/lib/analytics-types"

export const revalidate = 600

function parseLimit(raw: string | null): number {
  const n = parseInt(raw || "25", 10)
  if (!Number.isFinite(n) || n <= 0) return 25
  return Math.min(100, n)
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const role = (url.searchParams.get("role") || "lender").toLowerCase()
    if (role !== "lender" && role !== "borrower") {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 })
    }
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const limit = parseLimit(url.searchParams.get("limit"))
    const range = windowRange(window)

    const { data, error } = await supabaseAdmin.rpc("flowty_analytics_leaderboard", {
      p_role: role,
      p_start_at: range.startISO,
      p_end_at: range.endISO,
      p_collections: collections,
      p_limit: limit,
    })

    if (error) {
      console.log("[analytics/loans/leaderboard] rpc_error", error.message)
      return NextResponse.json({ error: "leaderboard_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as AnalyticsLeaderboardRow[]
    const names = await resolveUsernames(rows.map((r) => r.addr))
    const enriched = rows.map((r) => ({
      ...r,
      username: displayName(r.addr, names),
    }))

    return NextResponse.json(
      { role, rows: enriched },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/leaderboard] error", e?.message || e)
    return NextResponse.json({ error: "leaderboard_failed" }, { status: 500 })
  }
}
