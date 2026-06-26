import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { computeConfidence, escalateConfidence } from "@/lib/fmv-confidence"

// ── FMV Backfill Route ───────────────────────────────────────────────────────
//
// Finds editions that have sales history but NO fmv_snapshots row, then
// computes FMV using the same WAP + trimmed-median logic as fmv-recalc.
// Processes in batches of 100 to avoid timeouts.
//
// POST /api/fmv-backfill  (Bearer INGEST_SECRET_TOKEN)
// Body: { batchSize?: number }  (default 100, max 500)
// ─────────────────────────────────────────────────────────────────────────────

// Defensive server-side cap (route previously had none). With the candidate
// anti-join RPC this route runs in seconds; 120s leaves ample headroom under the
// 800s Pro ceiling and bounds any pathological per-edition processing.
export const maxDuration = 120

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

// FMV confidence-tier logic lives in lib/fmv-confidence.ts — shared with
// fmv-recalc so the HIGH/MEDIUM/LOW thresholds stay consistent (audit F11).

export async function POST(req: NextRequest) {
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    )
  }

  const startTime = Date.now()
  const now = new Date()

  const authHeader = req.headers.get("authorization")
  const receivedToken = authHeader?.replace("Bearer ", "") ?? ""
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

    // Step 1: Find editions that have a price>0 sale but no fmv_snapshots row,
    // limited to batchSize, via the indexed server-side anti-join RPC
    // fmv_backfill_candidates (migration audit_20260625_fmv_backfill_candidates_antijoin_rpc).
    // This replaces the previous approach of paginating the ENTIRE fmv_snapshots +
    // sales tables into in-memory Sets (~570 round-trips / ~570k rows), which hung
    // ~18min under DB load even when there was nothing to backfill. The candidate
    // set is identical; the RPC measures ~2.5s.
    const { data: candidateRows, error: candErr } = await (supabaseAdmin as any)
      .rpc("fmv_backfill_candidates", { p_limit: batchSize })

    if (candErr) {
      console.error("[FMV-BACKFILL] candidate RPC error:", candErr.message, candErr)
      return NextResponse.json(
        { ok: false, error: "Failed to fetch backfill candidates: " + candErr.message },
        { status: 500 }
      )
    }

    const editionIds: string[] = (candidateRows ?? [])
      .map((r: any) => (typeof r === "string" ? r : r?.ed_id))
      .filter(Boolean)

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
    const allSales: { edition_id: string; collection_id: string; price_usd: number; sold_at: string; serial_number: number | null }[] = []

    for (let i = 0; i < editionIds.length; i += CHUNK) {
      const chunk = editionIds.slice(i, i + CHUNK)
      const { data: salesData } = await (supabaseAdmin as any)
        .from("sales")
        .select("edition_id, collection_id, price_usd, sold_at, serial_number")
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
          .select("edition_id, collection_id, price_usd, sold_at, serial_number")
          .in("edition_id", chunk)
          .gt("price_usd", 0)
          .order("sold_at", { ascending: false })
          .limit(1000)

        if (salesData) allSales.push(...salesData)
      }
    }

    // Step 3: Group sales by edition
    const editionSalesMap = new Map<string, {
      sales: { price: number; soldAt: Date; serial: number | null }[]
      collectionId: string
      latestSoldAt: Date
    }>()

    for (const row of allSales) {
      const price = Number(row.price_usd)
      const soldAt = new Date(row.sold_at)
      const serial = row.serial_number == null ? null : Number(row.serial_number)
      const existing = editionSalesMap.get(row.edition_id)
      if (existing) {
        existing.sales.push({ price, soldAt, serial })
        if (soldAt > existing.latestSoldAt) existing.latestSoldAt = soldAt
      } else {
        editionSalesMap.set(row.edition_id, {
          sales: [{ price, soldAt, serial }],
          collectionId: row.collection_id,
          latestSoldAt: soldAt,
        })
      }
    }

    // ULTIMATE rows in fmv_snapshots are owned exclusively by recalc_ultimate_fmv
    // (the ultimate-v1 algo, which excludes special-serial sales). Drop ULTIMATE
    // editions from this backfill so legacy WAP+median values cannot land here.
    let ultimateSkipped = 0
    try {
      const ultimateIds = new Set<string>()
      const mapKeys = [...editionSalesMap.keys()]
      const TIER_CHUNK = 200
      for (let i = 0; i < mapKeys.length; i += TIER_CHUNK) {
        const chunk = mapKeys.slice(i, i + TIER_CHUNK)
        const { data: tierRows } = await (supabaseAdmin as any)
          .from("editions")
          .select("id, tier")
          .in("id", chunk)
          .eq("tier", "ULTIMATE")
        for (const row of tierRows ?? []) {
          if ((row as any)?.id) ultimateIds.add(String((row as any).id))
        }
      }
      for (const edId of ultimateIds) {
        if (editionSalesMap.delete(edId)) ultimateSkipped++
      }
      if (ultimateSkipped > 0) {
        console.log(`[FMV-BACKFILL] Skipped ${ultimateSkipped} ULTIMATE editions (owned by recalc_ultimate_fmv)`)
      }
    } catch (err) {
      console.warn(
        "[FMV-BACKFILL] ULTIMATE skip lookup failed (non-fatal):",
        err instanceof Error ? err.message : err
      )
    }

    // Step 4: Compute FMV and insert snapshots
    const insertRows: Record<string, unknown>[] = []

    for (const [editionId, { sales, collectionId, latestSoldAt }] of editionSalesMap.entries()) {
      const prices = sales.map(s => s.price)
      const serials = sales.map(s => s.serial)
      const median = trimmedMedian(prices)
      const wap = weightedAveragePrice(sales, now)
      const floor = Math.min(...prices)
      const baseConfidence = computeConfidence(sales.length)
      // serials enable the serial-residual HIGH dispersion gate (see lib/fmv-confidence.ts).
      const confidence = escalateConfidence(baseConfidence, sales.length, prices, serials)
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

    // Step 6: We only fetched up to batchSize candidates, so report whether more
    // remain. A precise backlog total would need a second full anti-join scan, so
    // it's reported as null when we filled the batch (more exist) vs 0 when we didn't.
    const hasMore = editionIds.length >= batchSize
    const remaining = hasMore ? null : 0
    const duration = Date.now() - startTime

    console.log(
      `[FMV-BACKFILL] Done — found=${editionIds.length} inserted=${snapshotsInserted} hasMore=${hasMore} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      editionsFound: editionIds.length,
      snapshotsInserted,
      remaining,
      hasMore,
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
