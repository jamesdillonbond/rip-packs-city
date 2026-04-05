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

    // Step 1: Find edition_ids that have sales but no fmv_snapshots row
    const { data: uncoveredRaw, error: queryError } = await (supabaseAdmin as any)
      .rpc("execute_sql", {
        query: `
          SELECT DISTINCT s.edition_id
          FROM sales s
          LEFT JOIN fmv_snapshots fs ON fs.edition_id = s.edition_id
          WHERE fs.edition_id IS NULL
            AND s.price_usd > 0
          LIMIT ${batchSize}
        `,
      })

    if (queryError) {
      console.error("[FMV-BACKFILL] Query error:", queryError.message)
      return NextResponse.json({ ok: false, error: queryError.message }, { status: 500 })
    }

    const uncoveredEditions = (uncoveredRaw as { edition_id: string }[]) ?? []
    const editionIds = uncoveredEditions.map(r => r.edition_id)

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

    // Step 6: Check how many remain
    const { data: remainingRaw } = await (supabaseAdmin as any)
      .rpc("execute_sql", {
        query: `
          SELECT COUNT(DISTINCT s.edition_id)::int AS cnt
          FROM sales s
          LEFT JOIN fmv_snapshots fs ON fs.edition_id = s.edition_id
          WHERE fs.edition_id IS NULL
            AND s.price_usd > 0
        `,
      })

    const remaining = (remainingRaw as { cnt: number }[])?.[0]?.cnt ?? 0
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
    console.error("[FMV-BACKFILL] Fatal error:", e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Backfill failed" },
      { status: 500 }
    )
  }
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}
