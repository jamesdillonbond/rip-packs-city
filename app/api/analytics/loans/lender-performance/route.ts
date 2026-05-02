// GET /api/analytics/loans/lender-performance
//
// Thin wrapper over analytics_lender_performance(p_collections, p_min_loans,
// p_limit). Returns the realized-yield ranking of lenders with completed
// loans (active loans excluded).
//
// Query params:
//   collections  comma-separated list (optional)
//   min_loans    1..50  (default 5)
//   limit        1..100 (default 25)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { LenderPerformanceRow } from "@/lib/analytics-types"

export const revalidate = 600

function parseInt32(raw: string | null, dflt: number, min: number, max: number): number {
  if (raw == null || raw === "") return dflt
  const n = parseInt(raw, 10)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.min(max, Math.max(min, n))
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))
    const minLoans = parseInt32(url.searchParams.get("min_loans"), 5, 1, 50)
    const limit = parseInt32(url.searchParams.get("limit"), 25, 1, 100)

    console.log(
      `[loans/lender-performance] start collections=${collections?.join(",") ?? "all"} min_loans=${minLoans} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<LenderPerformanceRow[]>(
      supabaseAdmin,
      "analytics_lender_performance",
      {
        p_collections: collections,
        p_min_loans: minLoans,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[loans/lender-performance] rpc_error", error.message)
      return NextResponse.json({ error: "lender_performance_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as LenderPerformanceRow[]

    console.log(
      `[loans/lender-performance] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
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
    console.log("[loans/lender-performance] error", e?.message || e)
    return NextResponse.json({ error: "lender_performance_failed" }, { status: 500 })
  }
}
