import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── FMV Recalc Route ──────────────────────────────────────────────────────────
//
// Recomputes FMV snapshots from the full 30-day sales history in the `sales`
// table, rather than relying on the batch-level prices seen during ingest.
//
// Model: trimmed median (drop bottom 10% + top 10% of prices per edition)
// Window: 30 days
// Confidence: HIGH >= 5 sales, MEDIUM >= 2, LOW = 1
// algo_version: "1.2.0"
//
// NOTE: fmv_snapshots is a partitioned table (partition key: computed_at).
// Upsert with onConflict does not work without a unique constraint covering
// all partition columns. We use delete-then-insert instead.
//
// Run via POST /api/fmv-recalc (token-gated, same as ingest)
// Paginated — pass { offset, limit } in body to process in chunks.
// ─────────────────────────────────────────────────────────────────────────────

const ALGO_VERSION = "1.2.0"
const WINDOW_DAYS = 30
const DEFAULT_LIMIT = 500

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

function computeConfidence(salesCount: number): "HIGH" | "MEDIUM" | "LOW" {
  if (salesCount >= 5) return "HIGH"
  if (salesCount >= 2) return "MEDIUM"
  return "LOW"
}

export async function POST(req: NextRequest) {
  const startTime = Date.now()

  const authHeader = req.headers.get("authorization")
  const expectedToken = process.env.INGEST_SECRET_TOKEN
  if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const limit = Math.min(Number(body.limit ?? DEFAULT_LIMIT), 2000)
    const offset = Number(body.offset ?? 0)

    const windowStart = new Date(
      Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    console.log(
      `[FMV-RECALC] Starting — offset=${offset} limit=${limit} window=${WINDOW_DAYS}d since=${windowStart}`
    )

    // ── Step 1: Get sales rows in window (paginated) ──────────────────────────
    const { data: salesPage, error: pageError } = await supabaseAdmin
      .from("sales")
      .select("edition_id, collection_id, price_usd")
      .gte("sold_at", windowStart)
      .gt("price_usd", 0)
      .range(offset, offset + limit - 1)
      .order("edition_id")

    if (pageError) {
      console.error("[FMV-RECALC] Sales page fetch error:", pageError.message)
      return NextResponse.json({ ok: false, error: pageError.message }, { status: 500 })
    }

    if (!salesPage || salesPage.length === 0) {
      console.log("[FMV-RECALC] No sales found in window — done")
      return NextResponse.json({
        ok: true,
        editionsProcessed: 0,
        snapshotsUpdated: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
      })
    }

    // ── Step 2: Group prices by edition ──────────────────────────────────────
    const editionPriceMap = new Map<string, { prices: number[]; collectionId: string }>()

    for (const row of salesPage) {
      const existing = editionPriceMap.get(row.edition_id)
      if (existing) {
        existing.prices.push(Number(row.price_usd))
      } else {
        editionPriceMap.set(row.edition_id, {
          prices: [Number(row.price_usd)],
          collectionId: row.collection_id,
        })
      }
    }

    const editionIds = [...editionPriceMap.keys()]
    console.log(`[FMV-RECALC] Processing ${editionIds.length} distinct editions`)

    // ── Step 3: Delete existing snapshots for these editions ─────────────────
    // fmv_snapshots is partitioned by computed_at — no unique constraint on
    // edition_id alone is possible, so upsert fails. Delete-then-insert instead.
    const { error: deleteError } = await supabaseAdmin
      .from("fmv_snapshots")
      .delete()
      .in("edition_id", editionIds)

    if (deleteError) {
      console.error("[FMV-RECALC] Delete error:", deleteError.message)
      return NextResponse.json({ ok: false, error: deleteError.message }, { status: 500 })
    }

    // ── Step 4: Build and insert fresh snapshots ──────────────────────────────
    const insertRows = []

    for (const [editionId, { prices, collectionId }] of editionPriceMap.entries()) {
      const fmv = trimmedMedian(prices)
      const floor = Math.min(...prices)
      const confidence = computeConfidence(prices.length)

      insertRows.push({
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(fmv.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        confidence,
        sales_count_7d: prices.length, // reflects 30-day window as of v1.2.0
        algo_version: ALGO_VERSION,
      })
    }

    const CHUNK_SIZE = 100
    let snapshotsUpdated = 0

    for (let i = 0; i < insertRows.length; i += CHUNK_SIZE) {
      const chunk = insertRows.slice(i, i + CHUNK_SIZE)
      const { error: insertError } = await supabaseAdmin
        .from("fmv_snapshots")
        .insert(chunk)

      if (insertError) {
        console.error("[FMV-RECALC] Insert error:", insertError.message)
      } else {
        snapshotsUpdated += chunk.length
      }
    }

    const hasMore = salesPage.length === limit
    const duration = Date.now() - startTime

    console.log(
      `[FMV-RECALC] Done — editions=${editionIds.length} snapshots=${snapshotsUpdated} hasMore=${hasMore} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      editionsProcessed: editionIds.length,
      snapshotsUpdated,
      hasMore,
      nextOffset: hasMore ? offset + limit : null,
      durationMs: duration,
    })
  } catch (e) {
    console.error("[FMV-RECALC] Fatal error:", e)
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Recalc failed" },
      { status: 500 }
    )
  }
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}