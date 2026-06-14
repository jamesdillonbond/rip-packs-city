// app/api/public/insights/top-sales/route.ts
//
// PUBLIC INSIGHTS — Top Sales / Whale Watch. The biggest recent sales across
// Flow, with the buyer and seller resolved to Top Shot @handles.
//
// Read-only JSON endpoint backing /insights/top-sales. Lives under
// /api/public/* so the proxy.ts allowlist lets it through with no auth. Reads
// the public `v_insights_top_sales` view (shipped Cowork
// `audit_20260613_v_insights_top_sales`, security_invoker=on, granted anon)
// which bounds to price_usd >= 100 + last 30d + thumbnail present (~600 rows),
// and enriches each row with buyer/seller @handles via the shared
// lib/insights/top-sales helper (the dapper.market resolution moat).
//
// Why this exists: the freshest, most shareable public surface — a daily
// reason to return — and the one place that names who bought and sold the
// grails. Strong long-tail SEO ("<player> biggest sale").
//
// Query params:
//   collection=nba_top_shot|nfl_all_day|laliga_golazos|disney_pinnacle|ufc_strike
//   window=7d|30d            filter sold_at; default 7d
//   sort=price|recent        default price (desc)
//   limit=<1..200>           default 100
//
// Response:
//   { meta: { fetched_at, source, total_rows, elapsed_ms, filters }, rows: [...] }
//
// CACHE: 15-min s-maxage. Sales move faster than trophies, so 15min (vs the
// trophy room's 1h) keeps the board fresh while protecting the DB from a viral
// OG-share spike.

import { NextRequest, NextResponse } from "next/server"
import {
  fetchTopSales,
  parseWindow,
  parseSort,
  TOP_SALES_VALID_COLLECTIONS,
} from "@/lib/insights/top-sales"

export async function GET(req: NextRequest) {
  const startedAt = Date.now()
  const sp = new URL(req.url).searchParams

  const collection = sp.get("collection")?.trim().toLowerCase() || null
  const window = parseWindow(sp.get("window"))
  const sort = parseSort(sp.get("sort"))
  const limit = Math.max(1, Math.min(200, Number(sp.get("limit") ?? "100")))

  if (collection && !TOP_SALES_VALID_COLLECTIONS.has(collection)) {
    return NextResponse.json(
      { error: `collection must be one of ${[...TOP_SALES_VALID_COLLECTIONS].join(",")}` },
      { status: 400 }
    )
  }

  let rows
  let fetchedAt
  try {
    ;({ rows, fetchedAt } = await fetchTopSales({ collection, window, sort, limit }))
  } catch (e) {
    console.error("[public/insights/top-sales]", e)
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "fetch_failed" },
      { status: 500 }
    )
  }

  const elapsedMs = Date.now() - startedAt
  console.log(
    `[public/insights/top-sales] returned=${rows.length} collection=${collection ?? "*"} window=${window} sort=${sort} elapsedMs=${elapsedMs}`
  )

  const res = NextResponse.json({
    meta: {
      fetched_at: fetchedAt,
      source: "v_insights_top_sales",
      total_rows: rows.length,
      elapsed_ms: elapsedMs,
      filters: { collection, window, sort, limit },
    },
    rows,
  })

  res.headers.set("Cache-Control", "public, s-maxage=900, stale-while-revalidate=300")
  return res
}
