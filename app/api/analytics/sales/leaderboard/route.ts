// GET /api/analytics/sales/leaderboard
//
// Thin wrapper over analytics_sales_leaderboard(p_role, p_start_at, p_end_at,
// p_collections, p_limit, p_min_volume, p_include_contracts). Returns the
// RPC rows plus a resolved username map so the client can render display
// names without an extra round-trip.
//
// Query params:
//   role        buyer | seller                               (default buyer)
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all   (default all)
//   collections comma-separated list                          (optional)
//   limit       1..100                                        (default 25)
//   min_volume  numeric                                       (default 100)
//
// Note: p_include_contracts is hardcoded to false. Platform contracts
// (Flowty/Dapper/Pinnacle/lending escrow addresses) should never appear
// on a buyer/seller leaderboard — they distort the ranks and confuse
// readers. There is no query param to flip this.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import { resolveUsernames, displayName } from "@/lib/flowty-username"
import type { SalesLeaderboardRow } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

function parseLimit(raw: string | null): number {
  const n = parseInt(raw || "25", 10)
  if (!Number.isFinite(n) || n <= 0) return 25
  return Math.min(100, n)
}

function parseMinVolume(raw: string | null): number {
  if (raw == null || raw === "") return 100
  const n = parseFloat(raw)
  if (!Number.isFinite(n) || n < 0) return 100
  return n
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const role = (url.searchParams.get("role") || "buyer").toLowerCase()
    if (role !== "buyer" && role !== "seller") {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 })
    }
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const limit = parseLimit(url.searchParams.get("limit"))
    const minVolume = parseMinVolume(url.searchParams.get("min_volume"))
    const range = windowRange(window)

    console.log(
      `[analytics/sales/leaderboard] start role=${role} window=${window} collections=${collections?.join(",") ?? "all"} limit=${limit} min_volume=${minVolume}`
    )

    const { data, error } = await rpcWithRetry<SalesLeaderboardRow[]>(
      supabaseAdmin,
      "analytics_sales_leaderboard",
      {
        p_role: role,
        p_start_at: range.startISO,
        p_end_at: range.endISO,
        p_collections: collections,
        p_limit: limit,
        p_min_volume: minVolume,
        p_include_contracts: false,
      }
    )

    if (error) {
      console.log("[analytics/sales/leaderboard] rpc_error", error.message)
      return NextResponse.json({ error: "leaderboard_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as SalesLeaderboardRow[]
    const names = await resolveUsernames(rows.map((r) => r.addr))
    const enriched = rows.map((r) => ({
      ...r,
      username: displayName(r.addr, names),
    }))

    console.log(
      `[analytics/sales/leaderboard] ok elapsed=${Date.now() - t0}ms rows=${enriched.length}`
    )

    return NextResponse.json(
      { role, rows: enriched },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/sales/leaderboard] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "leaderboard_failed" }, { status: 500 })
  }
}
