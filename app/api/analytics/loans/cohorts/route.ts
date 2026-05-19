// GET /api/analytics/loans/cohorts
//
// Thin wrapper over flowty_analytics_cohorts(p_role, p_collections). Returns
// monthly cohorts (switched from quarterly because the post-spork backfill
// window is only ~120 days, so quarterly buckets would all collapse into one
// row).
//
// Query params:
//   role        lender | borrower    (default borrower)
//   collections comma-separated list (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { AnalyticsCohortRow } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const role = (url.searchParams.get("role") || "borrower").toLowerCase()
    if (role !== "lender" && role !== "borrower") {
      return NextResponse.json({ error: "invalid_role" }, { status: 400 })
    }
    const collections = parseCollections(url.searchParams.get("collections"))

    console.log(
      `[analytics/loans/cohorts] start role=${role} collections=${collections?.join(",") ?? "all"}`
    )

    const { data, error } = await rpcWithRetry<AnalyticsCohortRow[]>(
      supabaseAdmin,
      "flowty_analytics_cohorts",
      {
        p_role: role,
        p_collections: collections,
      }
    )

    if (error) {
      console.log("[analytics/loans/cohorts] rpc_error", error.message)
      return NextResponse.json({ error: "cohorts_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as AnalyticsCohortRow[]
    console.log(`[analytics/loans/cohorts] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`)

    return NextResponse.json(
      { role, rows },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/loans/cohorts] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "cohorts_failed" }, { status: 500 })
  }
}
