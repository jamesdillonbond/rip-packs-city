import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── FMV Recalc Route ──────────────────────────────────────────────────────────
//
// Recomputes FMV snapshots from the full 30-day sales history in the `sales`
// table, rather than relying on the batch-level prices seen during ingest.
//
// This is the source of truth for confidence tiers — an edition with 8 total
// sales in the DB will correctly show MEDIUM/HIGH here, even if only 1 of
// those sales happened to be in a given ingest batch.
//
// Model: trimmed median (drop bottom 10% + top 10% of prices per edition)
// Window: 30 days
// Confidence: HIGH >= 5 sales, MEDIUM >= 2, LOW = 1
// algo_version: "1.2.0"
//
// Run via POST /api/fmv-recalc (token-gated, same as ingest)
// Paginated — pass { offset, limit } in body to process in chunks.
// ─────────────────────────────────────────────────────────────────────────────

const ALGO_VERSION = "1.2.0"
const WINDOW_DAYS = 30
const DEFAULT_LIMIT = 500 // editions per batch

function trimmedMedian(prices: number[]): number {
  if (prices.length === 0) return 0
  if (prices.length <= 2) {
    // Not enough data to trim — use plain median
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

  // Auth — same Bearer token as ingest
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

    // ── Step 1: Get distinct edition IDs with sales in window ────────────────
    const { data: editionRows, error: editionError } = await supabaseAdmin
      .from("sales")
      .select("edition_id")
      .gte("sold_at", windowStart)
      .range(offset, offset + limit - 1)
      .order("edition_id")

    if (editionError) {
      console.error("[FMV-RECALC] Edition fetch error:", editionError.message)
      return NextResponse.json({ ok: false, error: editionError.message }, { status: 500 })
    }

    if (!editionRows || editionRows.length === 0) {
      console.log("[FMV-RECALC] No editions found in window — done")
      return NextResponse.json({
        ok: true,
        editionsProcessed: 0,
        snapshotsUpdated: 0,
        hasMore: false,
        durationMs: Date.now() - startTime,
      })
    }

    // Deduplicate edition IDs
    const editionIds = [...new Set(editionRows.map((r) => r.edition_id as string))]

    console.log(`[FMV-RECALC] Processing ${editionIds.length} distinct editions`)

    // ── Step 2: Fetch all sales for these editions in the window ─────────────
    const { data: salesRows, error: salesError } = await supabaseAdmin
      .from("sales")
      .select("edition_id, collection_id, price_usd")
      .in("edition_id", editionIds)
      .gte("sold_at", windowStart)
      .gt("price_usd", 0)

    if (salesError) {
      console.error("[FMV-RECALC] Sales fetch error:", salesError.message)
      return NextResponse.json({ ok: false, error: salesError.message }, { status: 500 })
    }

    // ── Step 3: Group prices by edition ──────────────────────────────────────
    const editionPriceMap = new Map<string, { prices: number[]; collectionId: string }>()

    for (const row of salesRows ?? []) {
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

    // ── Step 4: Compute and upsert FMV snapshots ─────────────────────────────
    let snapshotsUpdated = 0
    const upsertRows = []

    for (const [editionId, { prices, collectionId }] of editionPriceMap.entries()) {
      const fmv = trimmedMedian(prices)
      const floor = Math.min(...prices)
      const confidence = computeConfidence(prices.length)

      upsertRows.push({
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(fmv.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        confidence,
        sales_count_7d: prices.length, // reflects 30-day window as of v1.2.0
        algo_version: ALGO_VERSION,
      })
    }

    // Batch upsert in chunks of 100 to stay within Supabase limits
    const CHUNK_SIZE = 100
    for (let i = 0; i < upsertRows.length; i += CHUNK_SIZE) {
      const chunk = upsertRows.slice(i, i + CHUNK_SIZE)
      const { error: upsertError } = await supabaseAdmin
        .from("fmv_snapshots")
        .upsert(chunk, { onConflict: "edition_id", ignoreDuplicates: false })

      if (upsertError) {
        console.error("[FMV-RECALC] Upsert error:", upsertError.message)
      } else {
        snapshotsUpdated += chunk.length
      }
    }

    const hasMore = editionRows.length === limit
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