// GET /api/analytics/listings/loan-offers
//
// Thin wrapper over analytics_listings_open_loan_offers(p_collections,
// p_sort, p_limit). Returns the open Flowty loan offers table that
// feeds the Listings dashboard primary panel.
//
// Query params:
//   collections  comma-separated list                                  (optional)
//   sort         apr_desc | apr_asc | principal_desc | principal_asc
//                | newest                                              (default apr_desc)
//   limit        default 25, max 100                                   (optional)

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { parseCollections } from "@/lib/analytics/window"
import { rpcWithRetry } from "@/lib/analytics/rpc-with-retry"
import type { ListingsOpenLoanOfferRow } from "@/lib/analytics-types"

export const revalidate = 300

const ALLOWED_SORTS = new Set([
  "apr_desc",
  "apr_asc",
  "principal_desc",
  "principal_asc",
  "newest",
])

function parseSort(raw: string | null): string {
  const v = (raw || "").toLowerCase()
  return ALLOWED_SORTS.has(v) ? v : "apr_desc"
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
    const sort = parseSort(url.searchParams.get("sort"))
    const limit = parseLimit(url.searchParams.get("limit"))

    console.log(
      `[analytics/listings/loan-offers] start collections=${collections?.join(",") ?? "all"} sort=${sort} limit=${limit}`
    )

    const { data, error } = await rpcWithRetry<ListingsOpenLoanOfferRow[]>(
      supabaseAdmin,
      "analytics_listings_open_loan_offers",
      {
        p_collections: collections,
        p_sort: sort,
        p_limit: limit,
      }
    )

    if (error) {
      console.log("[analytics/listings/loan-offers] rpc_error", error.message)
      return NextResponse.json({ error: "loan_offers_failed" }, { status: 500 })
    }

    const rows = (data ?? []) as ListingsOpenLoanOfferRow[]
    console.log(
      `[analytics/listings/loan-offers] ok elapsed=${Date.now() - t0}ms rows=${rows.length}`
    )

    return NextResponse.json(
      { rows, sort },
      {
        headers: {
          "Cache-Control": "public, max-age=0, s-maxage=300, stale-while-revalidate=600",
        },
      }
    )
  } catch (e: any) {
    console.log("[analytics/listings/loan-offers] error", e?.message || e, `elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: "loan_offers_failed" }, { status: 500 })
  }
}
