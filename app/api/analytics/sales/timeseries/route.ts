// GET /api/analytics/sales/timeseries
//
// Thin wrapper over analytics_sales_timeseries(p_start_at, p_end_at,
// p_collections, p_bucket). Each row is one (bucket, collection) pair —
// the client pivots them into stacked-area chart shape.
//
// Query params:
//   window      l7 | l30 | l90 | ytd | y2026 | y2025 | all  (default all)
//   collections comma-separated list                         (optional)
//   bucket      auto | day | week                            (default auto)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseWindow, windowRange, parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SalesTimeseriesRow } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

function parseBucket(raw: string | null): "auto" | "day" | "week" {
  const v = (raw || "").toLowerCase()
  if (v === "day" || v === "week") return v
  return "auto"
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const window = parseWindow(url.searchParams.get("window"))
    const collections = parseCollections(url.searchParams.get("collections"))
    const bucket = parseBucket(url.searchParams.get("bucket"))
    const range = windowRange(window)

    console.log(
      `[analytics/sales/timeseries] start window=${window} collections=${collections?.join(",") ?? "all"} bucket=${bucket}`
    )

    const { data, error } = await rpcWithRetry<SalesTimeseriesRow[]>(
      supabaseAdmin,
      "analytics_sales_timeseries",
      {
        p_start_at: range.startISO,
        p_end_at: range.endISO,
        p_collections: collections,
        p_bucket: bucket,
      }
    )

    if (error) {
      console.log("[analytics/sales/timeseries] rpc_error", error.message)
      return NextResponse.json({ error: "timeseries_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as SalesTimeseriesRow[]
    console.log(
      `[analytics/sales/timeseries] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows, bucket },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/sales/timeseries] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "timeseries_failed" }, { status: 500 })
  }
}
