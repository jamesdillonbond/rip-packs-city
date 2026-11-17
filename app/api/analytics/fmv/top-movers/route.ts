// GET /api/analytics/fmv/top-movers
//
// Thin wrapper over analytics_fmv_top_movers(p_collections, p_window_days,
// p_direction, p_min_fmv, p_limit).
//
// Query params:
//   collections   comma-separated list           (optional)
//   window_days   1 | 7 | 30                     (default 7)
//   direction     gainers | losers               (default gainers)
//   min_fmv       FMV floor in USD               (default 5)
//   limit         max rows                       (default 25, max 100)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { FmvTopMoverRow } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

const ALLOWED_WINDOWS = new Set([1, 7, 30])
const ALLOWED_DIRECTIONS = new Set(["gainers", "losers"])

function parseWindowDays(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 7
  if (!Number.isFinite(n) || !ALLOWED_WINDOWS.has(n)) return 7
  return n
}

function parseDirection(raw: string | null): "gainers" | "losers" {
  const v = (raw || "").toLowerCase()
  return ALLOWED_DIRECTIONS.has(v) ? (v as "gainers" | "losers") : "gainers"
}

function parseMinFmv(raw: string | null): number {
  const n = raw ? Number(raw) : 5
  if (!Number.isFinite(n) || n < 0) return 5
  return n
}

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 25
  if (!Number.isFinite(n) || n <= 0) return 25
  return Math.min(100, Math.max(1, n))
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))
    const windowDays = parseWindowDays(url.searchParams.get("window_days"))
    const direction = parseDirection(url.searchParams.get("direction"))
    const minFmv = parseMinFmv(url.searchParams.get("min_fmv"))
    const limit = parseLimit(url.searchParams.get("limit"))

    console.log(
      `[analytics/fmv/top-movers] start collections=${collections?.join(",") ?? "all"} window=${windowDays} direction=${direction} min_fmv=${minFmv} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<FmvTopMoverRow[]>(
      supabaseAdmin,
      "analytics_fmv_top_movers",
      {
        p_collections: collections,
        p_window_days: windowDays,
        p_direction: direction,
        p_min_fmv: minFmv,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/fmv/top-movers] rpc_error", error.message)
      return NextResponse.json({ error: "fmv_top_movers_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as FmvTopMoverRow[]
    console.log(
      `[analytics/fmv/top-movers] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows, window_days: windowDays, direction, min_fmv: minFmv },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/fmv/top-movers] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "fmv_top_movers_failed" }, { status: 500 })
  }
}
