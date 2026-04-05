import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── FMV Backfill Route ───────────────────────────────────────────────────────
//
// Finds editions that have sales history but NO fmv_snapshots row, then
// computes FMV using the same WAP + trimmed-median logic as fmv-recalc.
// Processes in batches of 100 to avoid timeouts.
//
// POST /api/fmv-backfill  (Bearer INGEST_SECRET_TOKEN)
// Body: { batchSize?: number }  (default 100, max 500)
// ─────────────────────────────────────────────────────────────────────────────

const ALGO_VERSION = "1.5.0"
const WINDOW_DAYS = 30

function trimmedMedian(prices: number[]): number {
  if (prices.length === 0) return 0
  if (prices.length <= 2) {
    const sorted = [...prices].sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid]
  }
  const sorted = [...prices].sort((a, b) => a - b)
  const trimCount = Math.max(1, Math.floor(sorted.length * 0.1))
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount)
  const mid = Math.floor(trimmed.length / 2)
  return trimmed.length % 2 === 0
    ? (trimmed[mid - 1] + trimmed[mid]) / 2
    : trimmed[mid]
}

function weightedAveragePrice(sales: { price: number; soldAt: Date }[], now: Date): number {
  if (sales.length === 0) return 0
  let weightedSum = 0
  let totalWeight = 0
  for (const sale of sales) {
    const ageDays = (now.getTime() - sale.soldAt.getTime()) / (1000 * 60 * 60 * 24)
    const weight = ageDays <= 7 ? 3.0 : ageDays <= 14 ? 2.0 : 1.0
    weightedSum += sale.price * weight
    totalWeight += weight
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

function computeConfidence(salesCount: number): "HIGH" | "MEDIUM" | "LOW" {
  if (salesCount >= 5) return "HIGH"
  if (salesCount >= 2) return "MEDIUM"
  return "LOW"
}

function escalateConfidence(
  base: "HIGH" | "MEDIUM" | "LOW",
  salesCount30d: number,
  prices: number[]
): "HIGH" | "MEDIUM" | "LOW" {
  let confidence = base
  if (confidence === "LOW" && salesCount30d >= 3) confidence = "MEDIUM"
  if (confidence !== "HIGH" && salesCount30d >= 8 && prices.length >= 8) {
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length
    if (mean > 0) {
      const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
      const stddev = Math.sqrt(variance)
      if (stddev / mean < 0.4) confidence = "HIGH"
    }
  }
  return confidence
}

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  const now = new Date()

  // Auth check
  const authHeader = req.headers.get("authorization")
  const receivedToken = authHeader?.replace("Bearer ", "") ?? ""
  const ingestToken = process.env.INGEST_SECRET_TOKEN ?? "rippackscity2026"
  const cronSecret = process.env.CRON_SECRET

  const isAuthed =
    receivedToken === ingestToken ||
    (cronSecret && receivedToken === cronSecret)

  if (!isAuthed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const batchSize = Math.min(Number(body.batchSize ?? 100), 500)

    const windowStart = new Date(
      Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    console.log(`[FMV-BACKFILL] Starting — batchSize=${batchSize} window=${WINDOW_DAYS}d`)

    // Step 1: Find edition_ids that have sales but no fmv_snapshots row.
    // Since Supabase JS doesn't support LEFT JOIN exclusion, we:
    //   a) Fetch all edition_ids that already have an fmv_snapshot
    //   b) Fetch distinct edition_ids from sales
    //   c) Subtract to find uncovered editions

    // 1a. Get all edition_ids with existing FMV snapshots
    const coveredIds = new Set<string>()
    let fmvOffset = 0
    const FMV_PAGE = 1000
    while (true) {
      const { data: fmvPage, error: fmvErr } = await (supabaseAdmin as any)
        .from("fmv_snapshots")
        .select("edition_id")
        .range(fmvOffset, fmvOffset + FMV_PAGE - 1)

      if (fmvErr) {
        console.error("[FMV-BACKFILL] Error fetching fmv_snapshots edition_ids:", fmvErr.message, fmvErr)
        return NextResponse.json({ ok: false, error: "Failed to fetch existing FMV snapshots: " + fmvErr.message }, { status: 500 })
      }

      if (!fmvPage || fmvPage.length === 0) break
      for (const row of fmvPage) coveredIds.add(row.edition_id)
      if (fmvPage.length < FMV_PAGE) break
      fmvOffset += FMV_PAGE
    }

    console.log(`[FMV-BACKFILL] Found ${coveredIds.size} editions already covered by fmv_snapshots`)

    // 1b. Get distinct edition_ids from sales that have price > 0
    const salesEditionIds = new Set<string>()
    let salesOffset = 0
    const SALES_PAGE = 1000
    while (true) {
      const { data: salesPage, error: salesErr } = await (supabaseAdmin as any)
        .from("sales")
        .select("edition_id")
        .gt("price_usd", 0)
        .range(salesOffset, salesOffset + SALES_PAGE - 1)

      if (salesErr) {
        console.error("[FMV-BACKFILL] Error fetching sales edition_ids:", salesErr.message, salesErr)
        return NextResponse.json({ ok: false, error: "Failed to fetch sales edition_ids: " + salesErr.message }, { status: 500 })
      }

      if (!salesPage || salesPage.length === 0) break
      for (const row of salesPage) salesEditionIds.add(row.edition_id)
      if (salesPage.length < SALES_PAGE) break
      salesOffset += SALES_PAGE
    }

    console.log(`[FMV-BACKFILL] Found ${salesEditionIds.size} distinct editions with sales`)

    // 1c. Find uncovered: editions with sales but no snapshot
    const uncoveredAll: string[] = []
    for (const edId of salesEditionIds) {
      if (!coveredIds.has(edId)) uncoveredAll.push(edId)
    }

    // Limit to batchSize
    const editionIds = uncoveredAll.slice(0, batchSize)

    if (!editionIds.length) {
      console.log("[FMV-BACKFILL] No uncovered editions found — all caught up")
      return NextResponse.json({
        ok: true,
        editionsFound: 0,
        snapshotsInserted: 0,
        remaining: 0,
        durationMs: Date.now() - startTime,
      })
    }

    console.log(`[FMV-BACKFILL] Found ${editionIds.length} editions with sales but no FMV snapshot`)

    // Step 2: Fetch all sales for these editions within the window
    const CHUNK = 50
    const allSales: { edition_id: string; collection_id: string; price_usd: number; sold_at: string }[] = []

    for (let i = 0; i < editionIds.length; i += CHUNK) {
      const chunk = editionIds.slice(i, i + CHUNK)
      const { data: salesData } = await (supabaseAdmin as any)
        .from("sales")
        .select("edition_id, collection_id, price_usd, sold_at")
        .in("edition_id", chunk)
        .gte("sold_at", windowStart)
        .gt("price_usd", 0)

      if (salesData) allSales.push(...salesData)
    }

    if (!allSales.length) {
      // Editions exist but no sales in window — try all-time sales
      for (let i = 0; i < editionIds.length; i += CHUNK) {
        const chunk = editionIds.slice(i, i + CHUNK)
        const { data: salesData } = await (supabaseAdmin as any)
          .from("sales")
          .select("edition_id, collection_id, price_usd, sold_at")
          .in("edition_id", chunk)
          .gt("price_usd", 0)
          .order("sold_at", { ascending: false })
          .limit(1000)

        if (salesData) allSales.push(...salesData)
      }
    }

    // Step 3: Group sales by edition
    const editionSalesMap = new Map<string, {
      sales: { price: number; soldAt: Date }[]
      collectionId: string
      latestSoldAt: Date
    }>()

    for (const row of allSales) {
      const price = Number(row.price_usd)
      const soldAt = new Date(row.sold_at)
      const existing = editionSalesMap.get(row.edition_id)
      if (existing) {
        existing.sales.push({ price, soldAt })
        if (soldAt > existing.latestSoldAt) existing.latestSoldAt = soldAt
      } else {
        editionSalesMap.set(row.edition_id, {
          sales: [{ price, soldAt }],
          collectionId: row.collection_id,
          latestSoldAt: soldAt,
        })
      }
    }

    // Step 4: Compute FMV and insert snapshots
    const insertRows: Record<string, unknown>[] = []

    for (const [editionId, { sales, collectionId, latestSoldAt }] of editionSalesMap.entries()) {
      const prices = sales.map(s => s.price)
      const median = trimmedMedian(prices)
      const wap = weightedAveragePrice(sales, now)
      const floor = Math.min(...prices)
      const baseConfidence = computeConfidence(sales.length)
      const confidence = escalateConfidence(baseConfidence, sales.length, prices)
      const daysSinceSale = Math.round(
        (now.getTime() - latestSoldAt.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Use WAP as primary FMV (more recent-sale-weighted), fall back to median
      const fmv = wap > 0 ? wap : median

      insertRows.push({
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(fmv.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        wap_usd: Number(wap.toFixed(2)),
        confidence,
        sales_count_7d: sales.filter(s => {
          const ageDays = (now.getTime() - s.soldAt.getTime()) / (1000 * 60 * 60 * 24)
          return ageDays <= 7
        }).length,
        sales_count_30d: sales.length,
        days_since_sale: daysSinceSale,
        algo_version: ALGO_VERSION,
      })
    }

    // Step 5: Insert in chunks of 100
    const INSERT_CHUNK = 100
    let snapshotsInserted = 0

    for (let i = 0; i < insertRows.length; i += INSERT_CHUNK) {
      const chunk = insertRows.slice(i, i + INSERT_CHUNK)
      const { error: insertError } = await supabaseAdmin
        .from("fmv_snapshots")
        .insert(chunk)

      if (insertError) {
        console.error("[FMV-BACKFILL] Insert error:", insertError.message, { chunkIndex: i })
      } else {
        snapshotsInserted += chunk.length
      }
    }

    // Step 6: Remaining = total uncovered minus what we just processed
    const remaining = Math.max(0, uncoveredAll.length - editionIds.length)
    const duration = Date.now() - startTime

    console.log(
      `[FMV-BACKFILL] Done — found=${editionIds.length} inserted=${snapshotsInserted} remaining=${remaining} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      editionsFound: editionIds.length,
      snapshotsInserted,
      remaining,
      durationMs: duration,
    })
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e)
    const errStack = e instanceof Error ? e.stack : undefined
    console.error("[FMV-BACKFILL] Fatal error:", errMsg)
    if (errStack) console.error("[FMV-BACKFILL] Stack:", errStack)
    return NextResponse.json(
      { ok: false, error: errMsg },
      { status: 500 }
    )
  }
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}
