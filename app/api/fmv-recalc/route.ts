import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── FMV Recalc Route ──────────────────────────────────────────────────────────
//
// Recomputes FMV snapshots from the full 30-day sales history in the `sales`
// table, rather than relying on the batch-level prices seen during ingest.
//
// Model: trimmed median (drop bottom 10% + top 10% of prices per edition)
// WAP: recency-weighted average price (7-day half-life exponential decay)
// Window: 30 days
// Confidence: HIGH >= 5 sales, MEDIUM >= 2, LOW = 1
// algo_version: "1.3.0"
//
// Populates: fmv_usd, floor_price_usd, wap_usd, confidence,
//            sales_count_7d (30d window), sales_count_30d, days_since_sale
//
// NOTE: fmv_snapshots is a partitioned table (partition key: computed_at).
// Upsert with onConflict does not work without a unique constraint covering
// all partition columns. We use delete-then-insert instead.
//
// Run via POST /api/fmv-recalc (token-gated, same as ingest)
// Paginated — pass { offset, limit } in body to process in chunks.
// ─────────────────────────────────────────────────────────────────────────────

const ALGO_VERSION = "1.4.0"
const WINDOW_DAYS = 30
const DEFAULT_LIMIT = 500

// WAP half-life in seconds — 7 days means a sale from 7 days ago
// carries ~37% of the weight of a sale from today.
const WAP_HALF_LIFE_SECONDS = 7 * 24 * 60 * 60

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

// Recency-weighted average price.
// Each sale is weighted by e^(-age_seconds / half_life).
// Recent sales dominate; sales older than 2x half_life contribute minimally.
function weightedAveragePrice(sales: { price: number; soldAt: Date }[], now: Date): number {
  if (sales.length === 0) return 0
  let weightedSum = 0
  let totalWeight = 0
  for (const sale of sales) {
    const ageSeconds = (now.getTime() - sale.soldAt.getTime()) / 1000
    const weight = Math.exp(-ageSeconds / WAP_HALF_LIFE_SECONDS)
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

export async function POST(req: NextRequest) {
  const startTime = Date.now()
  const now = new Date()

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
    console.log(`[FMV-RECALC] SUPABASE_SERVICE_ROLE_KEY set: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}, length: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0}`)

    // ── Step 1: Get sales rows in window (paginated) ──────────────────────────
    // Also fetching sold_at for WAP and days_since_sale computation
    const { data: salesPage, error: pageError } = await supabaseAdmin
      .from("sales")
      .select("edition_id, collection_id, price_usd, sold_at")
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

    // ── Step 2: Group sales by edition ────────────────────────────────────────
    const editionSalesMap = new Map<string, {
      sales: { price: number; soldAt: Date }[]
      collectionId: string
      latestSoldAt: Date
    }>()

    for (const row of salesPage) {
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

    const editionIds = [...editionSalesMap.keys()]
    console.log(`[FMV-RECALC] Processing ${editionIds.length} distinct editions`)

    // ── Step 2b: Fetch Flowty LiveToken FMVs from cached_listings ────────────
    // cached_listings.fmv contains valuations.blended.usdValue from Flowty's
    // LiveToken feed. We average per edition (multiple listings may exist).
    // The editions table maps edition_id → external_id; cached_listings uses
    // flow_id (nft-level), so we join through the moments table.
    const flowtyFmvByEdition = new Map<string, number>()
    let flowtyFmvCount = 0

    try {
      // Get all flow_ids that have a Flowty FMV in cached_listings
      const { data: fmvListings } = await supabaseAdmin
        .from("cached_listings")
        .select("flow_id, fmv")
        .eq("source", "flowty")
        .not("fmv", "is", null)
        .gt("fmv", 0)

      if (fmvListings && fmvListings.length > 0) {
        // Map flow_id → fmv values
        const flowIdFmvs = new Map<string, number[]>()
        for (const row of fmvListings) {
          if (!row.flow_id || !row.fmv) continue
          const existing = flowIdFmvs.get(String(row.flow_id))
          if (existing) existing.push(Number(row.fmv))
          else flowIdFmvs.set(String(row.flow_id), [Number(row.fmv)])
        }

        // Look up which editions these flow_ids belong to via moments table
        const flowIds = [...flowIdFmvs.keys()]
        const { data: momentRows } = await supabaseAdmin
          .from("moments")
          .select("nft_id, edition_id")
          .in("nft_id", flowIds)

        // Aggregate FMVs per edition_id
        const editionFmvs = new Map<string, number[]>()
        for (const row of momentRows ?? []) {
          if (!row.edition_id) continue
          const fmvValues = flowIdFmvs.get(String(row.nft_id))
          if (!fmvValues) continue
          const existing = editionFmvs.get(row.edition_id)
          if (existing) existing.push(...fmvValues)
          else editionFmvs.set(row.edition_id, [...fmvValues])
        }

        // Average per edition
        for (const [edId, fmvValues] of editionFmvs.entries()) {
          if (!editionSalesMap.has(edId)) continue // only blend for editions we're recalcing
          const avg = fmvValues.reduce((a, b) => a + b, 0) / fmvValues.length
          if (avg > 0) {
            flowtyFmvByEdition.set(edId, avg)
            flowtyFmvCount++
          }
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Flowty FMV fetch failed (non-fatal):", err)
    }

    console.log(`[FMV-RECALC] Flowty LiveToken FMV available for ${flowtyFmvCount} editions`)

    // ── Step 2c: Fetch floor ask prices from cached_listings ────────────────
    // For LOW confidence editions, floor_ask * 0.90 serves as a provisional
    // FMV proxy (ask_proxy_fmv) without overwriting the sales-based fmv_usd.
    const floorAskByEdition = new Map<string, number>()

    try {
      const { data: askListings } = await supabaseAdmin
        .from("cached_listings")
        .select("flow_id, ask_price")
        .not("ask_price", "is", null)
        .gt("ask_price", 0)

      if (askListings && askListings.length > 0) {
        // Map flow_id → minimum ask price
        const flowIdAsks = new Map<string, number>()
        for (const row of askListings) {
          if (!row.flow_id || !row.ask_price) continue
          const price = Number(row.ask_price)
          const existing = flowIdAsks.get(String(row.flow_id))
          if (!existing || price < existing) {
            flowIdAsks.set(String(row.flow_id), price)
          }
        }

        // Look up editions via moments table
        const askFlowIds = [...flowIdAsks.keys()]
        const { data: askMomentRows } = await supabaseAdmin
          .from("moments")
          .select("nft_id, edition_id")
          .in("nft_id", askFlowIds)

        // Find minimum ask per edition
        for (const row of askMomentRows ?? []) {
          if (!row.edition_id) continue
          const askPrice = flowIdAsks.get(String(row.nft_id))
          if (!askPrice) continue
          const existing = floorAskByEdition.get(row.edition_id)
          if (!existing || askPrice < existing) {
            floorAskByEdition.set(row.edition_id, askPrice)
          }
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Floor ask fetch failed (non-fatal):", err)
    }

    console.log(`[FMV-RECALC] Floor ask available for ${floorAskByEdition.size} editions`)

    // ── Step 3: Delete existing snapshots for these editions ─────────────────
    const { error: deleteError, status: delStatus } = await supabaseAdmin
      .from("fmv_snapshots")
      .delete()
      .in("edition_id", editionIds)

    if (deleteError) {
      console.error("DB write failed:", deleteError, { status: delStatus })
      return NextResponse.json({ ok: false, error: deleteError.message }, { status: 500 })
    }

    // ── Step 4: Build and insert fresh snapshots ──────────────────────────────
    // FMV blending: when a Flowty LiveToken FMV is available and within 3x of
    // WAP (outlier filter), blend it as a secondary signal:
    //   blended_fmv = (wap * 0.6) + (livetoken_fmv * 0.4)
    // Otherwise, use trimmed median as before.
    const insertRows: Record<string, unknown>[] = []
    let blendedCount = 0
    let askProxyCount = 0

    for (const [editionId, { sales, collectionId, latestSoldAt }] of editionSalesMap.entries()) {
      const prices = sales.map(s => s.price)

      const median = trimmedMedian(prices)
      const wap = weightedAveragePrice(sales, now)
      const floor = Math.min(...prices)
      let confidence: string = computeConfidence(sales.length)
      const daysSinceSale = Math.round(
        (now.getTime() - latestSoldAt.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Blend Flowty LiveToken FMV if available and within 3x of WAP
      let fmv = median
      const livetokenFmv = flowtyFmvByEdition.get(editionId)
      if (livetokenFmv && wap > 0) {
        const ratio = livetokenFmv / wap
        if (ratio >= 1 / 3 && ratio <= 3) {
          fmv = (wap * 0.6) + (livetokenFmv * 0.4)
          blendedCount++
        }
      }

      // For LOW confidence editions with a Flowty floor ask, compute a
      // provisional FMV proxy at 90% of floor ask. This improves sniper deal
      // matching without corrupting the sales-based fmv_usd.
      let askProxyFmv: number | null = null
      if (confidence === "LOW") {
        const floorAsk = floorAskByEdition.get(editionId)
        if (floorAsk && floorAsk > 0) {
          askProxyFmv = Number((floorAsk * 0.90).toFixed(2))
          confidence = "LOW_ASK_PROXY"
          askProxyCount++
        }
      }

      insertRows.push({
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(fmv.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        wap_usd: Number(wap.toFixed(2)),
        confidence,
        ask_proxy_fmv: askProxyFmv,
        sales_count_7d: sales.length,    // column name retained for schema compat; reflects 30d window
        sales_count_30d: sales.length,
        days_since_sale: daysSinceSale,
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
        console.error("DB write failed:", insertError, { chunkIndex: i, chunkSize: chunk.length })
      } else {
        snapshotsUpdated += chunk.length
      }
    }

    const hasMore = salesPage.length === limit
    const duration = Date.now() - startTime

    console.log(
      `[FMV-RECALC] Done — editions=${editionIds.length} snapshots=${snapshotsUpdated} blended=${blendedCount} askProxy=${askProxyCount} hasMore=${hasMore} duration=${duration}ms`
    )

    return NextResponse.json({
      ok: true,
      editionsProcessed: editionIds.length,
      snapshotsUpdated,
      flowtyFmvBlended: blendedCount,
      askProxyApplied: askProxyCount,
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