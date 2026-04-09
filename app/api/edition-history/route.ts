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
//   history.wapClean = [0.15, 0.14, ...] (outlier-filtered WAP per day)
//
// NOTE: History accumulates over time. On day 1 after Item 1 shipped,
// only 1 day of data will exist. After 21 days, full history available.

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@supabase/supabase-js"

export async function GET(req: NextRequest) {
  const edition = req.nextUrl.searchParams.get("edition")
  const daysParam = parseInt(req.nextUrl.searchParams.get("days") ?? "21", 10)
  const days = Math.min(Math.max(daysParam, 1), 90)

  if (!edition || !edition.includes(":")) {
    return NextResponse.json({ error: "edition param required (format: setID:playID)" }, { status: 400 })
  }

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  )

  // Resolve external_id to internal UUID
  const { data: editionRow } = await (supabase as any)
    .from("editions")
    .select("id")
    .eq("external_id", edition)
    .single()

  if (!editionRow?.id) {
    return NextResponse.json({ error: "Edition not found", edition }, { status: 404 })
  }

  // Fetch snapshots for the last N days
  const since = new Date()
  since.setUTCDate(since.getUTCDate() - days)

  const { data: snapshots, error } = await (supabase as any)
    .from("fmv_snapshots")
    .select("fmv_usd, wap_usd, wap_without_outliers, floor_price_usd, confidence, liquidity_rating, sales_count_30d, days_since_sale, computed_at")
    .eq("edition_id", editionRow.id)
    .gte("computed_at", since.toISOString())
    .order("computed_at", { ascending: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!snapshots || snapshots.length === 0) {
    return NextResponse.json({
      edition,
      days,
      history: { days: [], values: [], sampleSizes: [], wapClean: [] },
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
  const wapCleanArr: (number | null)[] = []

  for (let d = 0; d < days; d++) {
    const checkDate = new Date(today)
    checkDate.setUTCDate(checkDate.getUTCDate() - d)
    const dateStr = checkDate.toISOString().slice(0, 10)
    const snap = byDate.get(dateStr)
    if (snap) {
      daysArr.push(-d)
      valuesArr.push(Number((snap.fmv_usd ?? 0).toFixed(4)))
      samplesArr.push(snap.sales_count_30d ?? null)
      wapCleanArr.push(snap.wap_without_outliers ? Number(Number(snap.wap_without_outliers).toFixed(4)) : null)
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
      wapClean: wapCleanArr,
    },
    current: {
      fmv: Number((latest.fmv_usd ?? 0).toFixed(4)),
      wap: latest.wap_usd ? Number(Number(latest.wap_usd).toFixed(4)) : null,
      wapClean: latest.wap_without_outliers ? Number(Number(latest.wap_without_outliers).toFixed(4)) : null,
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
