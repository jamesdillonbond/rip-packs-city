// GET /api/analytics/sets/directory
//
// Thin wrapper over analytics_sets_directory(p_collections, p_sort,
// p_min_coverage, p_limit). Returns one row per set with edition counts,
// FMV coverage, and aggregate value figures.
//
// Query params:
//   collections    comma-separated list                                 (optional)
//   sort           value_desc | value_asc | name_asc | newest | completion_desc
//                  (default value_desc)
//   min_coverage   integer 0-100 — filter to sets with coverage >= n    (default 0)
//   limit          integer max rows                                     (default 50, max 200)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { SetsDirectoryRow, SetsDirectorySort } from "@/lib/analytics-types"

export const dynamic = 'force-dynamic'
export const revalidate = 600

const ALLOWED_SORTS: ReadonlyArray<SetsDirectorySort> = [
  "value_desc",
  "value_asc",
  "name_asc",
  "newest",
  "completion_desc",
]

function parseSort(raw: string | null): SetsDirectorySort {
  const v = (raw || "").toLowerCase() as SetsDirectorySort
  return ALLOWED_SORTS.includes(v) ? v : "value_desc"
}

function parseMinCoverage(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 0
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.min(100, n)
}

function parseLimit(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : 50
  if (!Number.isFinite(n) || n <= 0) return 50
  return Math.min(200, Math.max(1, n))
}

export async function GET(req: NextRequest) {
  const t0 = Date.now()
  try {
    const url = new URL(req.url)
    const collections = parseCollections(url.searchParams.get("collections"))
    const sort = parseSort(url.searchParams.get("sort"))
    const minCoverage = parseMinCoverage(url.searchParams.get("min_coverage"))
    const limit = parseLimit(url.searchParams.get("limit"))

    console.log(
      `[analytics/sets/directory] start collections=${collections?.join(",") ?? "all"} sort=${sort} min_coverage=${minCoverage} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<SetsDirectoryRow[]>(
      supabaseAdmin,
      "analytics_sets_directory",
      {
        p_collections: collections,
        p_sort: sort,
        p_min_coverage: minCoverage,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/sets/directory] rpc_error", error.message)
      return NextResponse.json({ error: "sets_directory_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as SetsDirectoryRow[]
    console.log(
      `[analytics/sets/directory] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows, sort, min_coverage: minCoverage, limit },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=600, stale-while-revalidate=1200",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/sets/directory] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "sets_directory_failed" }, { status: 500 })
  }
}
