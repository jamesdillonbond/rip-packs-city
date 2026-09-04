// app/api/edition-history/route.ts
//
// Returns daily FMV history for a single edition.
// Equivalent to LiveToken's refValuesForEdition data.
//
// GET /api/edition-history?edition=218:8217&days=21
//
// Response shape matches LiveToken's pattern:
//   history.days    = [0, -1, -2, ...]  (relative to today)
//   history.values  = [0.16, 0.15, ...]  (daily FMV)
//   history.sampleSizes = [5, 6, ...]    (sales count backing each day)
//   history.aspClean = [0.15, 0.14, ...] (outlier-filtered avg sales price per day)
//
// NOTE: History accumulates over time. On day 1 after Item 1 shipped,
// only 1 day of data will exist. After 21 days, full history available.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export async function GET(req: NextRequest) {
  const edition = req.nextUrl.searchParams.get("edition")
  const daysParam = parseInt(req.nextUrl.searchParams.get("days") ?? "21", 10)
  // Guard NaN: a present-but-non-numeric ?days=abc → parseInt NaN, and
  // Math.min/Math.max do NOT sanitize NaN (Math.min(90, NaN) === NaN), so an
  // unguarded clamp yields days=NaN → since.setUTCDate(x - NaN) = Invalid Date
  // → since.toISOString() throws RangeError → anon-reachable 500 (this route is
  // in proxy.ts PUBLIC_READ_APIS and has no try/catch). Default back to 21.
  const days = Number.isFinite(daysParam) ? Math.min(Math.max(daysParam, 1), 90) : 21

  if (!edition || !edition.includes(":")) {
    return NextResponse.json({ error: "edition param required (format: setID:playID)" }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Resolve external_id to internal UUID.
  //
  // ⚠ HONESTY CANON, and the same instance already fixed in
  // `app/api/edition-stats/route.ts`. This read used to swallow its `error` and
  // branch on `!editionRow?.id`, so a FAILED read rendered 404 "Edition not
  // found" — a claim about our own catalogue, on a public entity surface.
  // `.maybeSingle()` rather than `.single()` for the same reason it was chosen
  // there: `.single()` errors on zero rows (PGRST116), which puts "absent" and
  // "unreadable" into the SAME `error` channel and makes them impossible to
  // separate without special-casing a driver code. With `maybeSingle` the two
  // states have their own branch each.
  const { data: editionRow, error: editionErr } = await boundedRead((supabase as any)
    .from("editions")
    .select("id")
    .eq("external_id", edition)
    .maybeSingle(), "api/edition-history/editions")

  if (editionErr) {
    return apiErrorResponse(editionErr, "api/edition-history")
  }
  if (!editionRow?.id) {
    return NextResponse.json({ error: "Edition not found", edition }, { status: 404 })
  }

  // Fetch snapshots for the last N days
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - days)

  const { data: snapshots, error } = await boundedRead((supabase as any)
    .from("fmv_snapshots")
    .select("fmv_usd, wap_usd:asp_usd, wap_without_outliers:asp_without_outliers, floor_price_usd, confidence, liquidity_rating, sales_count_30d, days_since_sale, computed_at")
    .eq("edition_id", editionRow.id)
    .gte("computed_at", since.toISOString())
    .order("computed_at", { ascending: false }), "api/edition-history/fmv_snapshots")

  if (error) {
    return apiErrorResponse(error, "api/edition-history")
  }

  if (!snapshots || snapshots.length === 0) {
    return NextResponse.json({
      edition,
      days,
      history: { days: [], values: [], sampleSizes: [], aspClean: [] },
      current: null,
    })
  }

  // Group by date, take latest per day
  const byDate = new Map<string, any>()
  for (const snap of snapshots) {
    const dateKey = (snap.computed_at as string | undefined)?.slice(0, 10)
    if (dateKey && !byDate.has(dateKey)) {
      byDate.set(dateKey, snap)
    }
  }

  // Build arrays relative to today
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)

  const daysArr: number[] = []
  const valuesArr: number[] = []
  const samplesArr: (number | null)[] = []
  const aspCleanArr: (number | null)[] = []

  for (let d = 0; d < days; d++) {
    const checkDate = new Date(today)
    checkDate.setUTCDate(checkDate.getUTCDate() - d)
    const dateStr = checkDate.toISOString().slice(0, 10)
    const snap = byDate.get(dateStr)
    if (snap) {
      daysArr.push(-d)
      valuesArr.push(Number((snap.fmv_usd ?? 0).toFixed(4)))
      samplesArr.push(snap.sales_count_30d ?? null)
      aspCleanArr.push(snap.wap_without_outliers ? Number(Number(snap.wap_without_outliers).toFixed(4)) : null)
    }
  }

  // Current = most recent snapshot
  const latest = snapshots[0]

  return NextResponse.json({
    edition,
    days,
    snapshotsFound: byDate.size,
    history: {
      days: daysArr,
      values: valuesArr,
      sampleSizes: samplesArr,
      aspClean: aspCleanArr,
    },
    current: {
      fmv: Number((latest.fmv_usd ?? 0).toFixed(4)),
      asp: latest.wap_usd ? Number(Number(latest.wap_usd).toFixed(4)) : null,
      aspClean: latest.wap_without_outliers ? Number(Number(latest.wap_without_outliers).toFixed(4)) : null,
      floor: latest.floor_price_usd ? Number(Number(latest.floor_price_usd).toFixed(4)) : null,
      confidence: (latest.confidence ?? "LOW").toUpperCase(),
      liquidityRating: latest.liquidity_rating ?? null,
      salesCount30d: latest.sales_count_30d ?? null,
      daysSinceSale: latest.days_since_sale ?? null,
    },
  }, {
    headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=60" },
  })
}
