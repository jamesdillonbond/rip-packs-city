// GET /api/analytics/packs/top-ev
//
// Thin wrapper over analytics_packs_top_ev(p_collections, p_min_price,
// p_max_price, p_min_unopened, p_min_coverage, p_direction, p_limit).
// Ranks pack listings by expected value relative to current ask.
//
// Query params:
//   collections    comma-separated list           (optional)
//   min_price      ask floor in USD               (default 1)
//   max_price      ask ceiling in USD             (default 5000)
//   min_unopened   minimum unopened supply        (default 1)
//   min_coverage   minimum FMV coverage pct       (default 50)
//   direction      pumping | dumping | fresh      (default pumping)
//   limit          max rows                       (default 25, max 100)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"

export const dynamic = 'force-dynamic'
export const revalidate = 600

const ALLOWED_DIRECTIONS = new Set(["pumping", "dumping", "fresh"])

function parseDirection(raw: string | null): "pumping" | "dumping" | "fresh" {
  const v = (raw || "").toLowerCase()
  return ALLOWED_DIRECTIONS.has(v)
    ? (v as "pumping" | "dumping" | "fresh")
    : "pumping"
}

function parseNumeric(raw: string | null, fallback: number): number {
  const n = raw ? Number(raw) : fallback
  if (!Number.isFinite(n) || n < 0) return fallback
  return n
}

function parseInt32(raw: string | null, fallback: number): number {
  const n = raw ? parseInt(raw, 10) : fallback
  if (!Number.isFinite(n) || n < 0) return fallback
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
    const minPrice = parseNumeric(url.searchParams.get("min_price"), 1)
    const maxPrice = parseNumeric(url.searchParams.get("max_price"), 5000)
    const minUnopened = parseInt32(url.searchParams.get("min_unopened"), 1)
    const minCoverage = parseInt32(url.searchParams.get("min_coverage"), 50)
    const direction = parseDirection(url.searchParams.get("direction"))
    const limit = parseLimit(url.searchParams.get("limit"))

    console.log(
      `[analytics/packs/top-ev] start collections=${collections?.join(",") ?? "all"} min_price=${minPrice} max_price=${maxPrice} min_unopened=${minUnopened} min_coverage=${minCoverage} direction=${direction} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<unknown[]>(
      supabaseAdmin,
      "analytics_packs_top_ev",
      {
        p_collections: collections,
        p_min_price: minPrice,
        p_max_price: maxPrice,
        p_min_unopened: minUnopened,
        p_min_coverage: minCoverage,
        p_direction: direction,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/packs/top-ev] rpc_error", error.message)
      return NextResponse.json({ error: "packs_top_ev_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as unknown[]
    console.log(
      `[analytics/packs/top-ev] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      {
        rows,
        min_price: minPrice,
        max_price: maxPrice,
        min_unopened: minUnopened,
        min_coverage: minCoverage,
        direction,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/packs/top-ev] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "packs_top_ev_failed" }, { status: 500 })
  }
}
