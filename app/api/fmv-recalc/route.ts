import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"

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

const ALGO_VERSION = "1.5.1"
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

// Recency-weighted average price with tiered decay:
//   0-7 days: weight 3.0, 7-14 days: weight 2.0, 14-30 days: weight 1.0
// This makes FMV react faster to recent price moves.
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

// Liquidity rating on a 0–5 scale based on the count of sales in the window.
// Surfaced via fmv_snapshots.liquidity_rating for downstream filtering.
function liquidityRating(salesCount: number): number {
  if (salesCount === 0) return 0
  if (salesCount <= 5) return 1
  if (salesCount <= 20) return 2
  if (salesCount <= 50) return 3
  if (salesCount <= 100) return 4
  return 5
}

// LiveToken averageWithoutWackos equivalent: drop sales >5x or <0.2x the
// median price, then run the existing weighted-average over what's left.
// Used as the primary FMV signal so wash trades and fat-finger sales never
// pollute the snapshot.
function wapWithoutOutliers(sales: { price: number; soldAt: Date }[], now: Date): number {
  if (sales.length === 0) return 0
  const prices = sales.map(s => s.price).sort((a, b) => a - b)
  const mid = Math.floor(prices.length / 2)
  const median = prices.length % 2 === 0 ? (prices[mid - 1] + prices[mid]) / 2 : prices[mid]
  if (median <= 0) return weightedAveragePrice(sales, now)
  const filtered = sales.filter(s => s.price >= median * 0.2 && s.price <= median * 5)
  if (filtered.length === 0) return weightedAveragePrice(sales, now)
  return weightedAveragePrice(filtered, now)
}

function computeConfidence(salesCount: number): "HIGH" | "MEDIUM" | "LOW" {
  if (salesCount >= 5) return "HIGH"
  if (salesCount >= 2) return "MEDIUM"
  return "LOW"
}

// Upward-only confidence escalation based on sales volume and price stability.
// If LOW + 3+ sales in 30d → MEDIUM. If 8+ sales + stddev < 40% of mean → HIGH.
function escalateConfidence(
  base: "HIGH" | "MEDIUM" | "LOW",
  salesCount30d: number,
  prices: number[]
): "HIGH" | "MEDIUM" | "LOW" {
  let confidence = base

  // Escalate LOW → MEDIUM if 3+ sales in 30 days
  if (confidence === "LOW" && salesCount30d >= 3) {
    confidence = "MEDIUM"
  }

  // Escalate to HIGH if 8+ sales and price stability (stddev < 40% of mean)
  if (confidence !== "HIGH" && salesCount30d >= 8 && prices.length >= 8) {
    const mean = prices.reduce((a, b) => a + b, 0) / prices.length
    if (mean > 0) {
      const variance = prices.reduce((s, p) => s + (p - mean) ** 2, 0) / prices.length
      const stddev = Math.sqrt(variance)
      if (stddev / mean < 0.4) {
        confidence = "HIGH"
      }
    }
  }

  return confidence
}

export async function POST(req: NextRequest) {
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    return NextResponse.json(
      { error: "Server misconfigured: INGEST_SECRET_TOKEN not set" },
      { status: 500 }
    )
  }

  const chain = req.nextUrl.searchParams.get("chain") === "true"
  const forceStale = req.nextUrl.searchParams.get("force_stale") === "true"

  const authHeader = req.headers.get("authorization")
  const receivedToken = authHeader?.replace("Bearer ", "") ?? ""
  const cronSecret = process.env.CRON_SECRET

  console.log(
    `[FMV-RECALC] Auth debug — received: "${receivedToken.slice(0, 8)}…" ` +
    `expected INGEST: "${ingestToken.slice(0, 8)}…" ` +
    `CRON_SECRET set: ${!!cronSecret}`
  )

  const isAuthed =
    receivedToken === ingestToken ||
    (cronSecret && receivedToken === cronSecret)

  if (!isAuthed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const limit = Math.min(Number(body.limit ?? DEFAULT_LIMIT), 2000)
  const offset = Number(body.offset ?? 0)

  // Recalc pages can exceed cron-job.org's 30s timeout. Run the heavy work
  // after the response is sent so callers get an immediate ack.
  after(async () => {
    const startTime = Date.now()
    const now = new Date()
    try {

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
      return
    }

    if (!salesPage || salesPage.length === 0) {
      // ── Integer edition FMV bridge (runs even when no sales in this batch) ──
      let integerBridgeCount = 0
      try {
        const { data: bridgeResult, error: bridgeError } = await supabaseAdmin
          .rpc("bridge_integer_fmv", { p_algo_version: ALGO_VERSION })

        if (bridgeError) {
          console.warn("[FMV-RECALC] Integer bridge error:", bridgeError.message)
        } else {
          integerBridgeCount = typeof bridgeResult === "number" ? bridgeResult : 0
          console.log(`[FMV-RECALC] Integer edition FMV bridge: ${integerBridgeCount} editions covered`)
        }
      } catch (err) {
        console.warn("[FMV-RECALC] Integer bridge error:", err instanceof Error ? err.message : err)
      }

      console.log(
        `[FMV-RECALC] No sales found in window — integerBridge=${integerBridgeCount} durationMs=${Date.now() - startTime}`
      )
      await fireNextPipelineStep("/api/listing-cache", chain)
      return
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

    // ── Step 2a: Wash-trade filter ─────────────────────────────────────────
    // Exclude suspicious sale clusters: if 3+ sales for the same edition occur
    // within a 10-minute window, remove all sales in that cluster from WAP.
    let washTradeEditionCount = 0
    const WASH_WINDOW_MS = 10 * 60 * 1000 // 10 minutes

    for (const [editionId, editionData] of editionSalesMap.entries()) {
      const { sales } = editionData
      if (sales.length < 3) continue

      // Sort by time to find clusters
      const sorted = [...sales].sort((a, b) => a.soldAt.getTime() - b.soldAt.getTime())
      const suspicious = new Set<number>() // indices into sorted array

      for (let i = 0; i < sorted.length; i++) {
        // Find how many sales fall within 10 min of sorted[i]
        const windowEnd = sorted[i].soldAt.getTime() + WASH_WINDOW_MS
        const clusterIndices: number[] = []
        for (let j = i; j < sorted.length && sorted[j].soldAt.getTime() <= windowEnd; j++) {
          clusterIndices.push(j)
        }
        if (clusterIndices.length >= 3) {
          for (const idx of clusterIndices) suspicious.add(idx)
        }
      }

      if (suspicious.size > 0) {
        const filtered = sorted.filter((_, idx) => !suspicious.has(idx))
        if (filtered.length === 0) {
          // All sales are suspicious — remove the edition entirely
          editionSalesMap.delete(editionId)
        } else {
          editionData.sales = filtered
          // Recompute latestSoldAt from remaining sales
          editionData.latestSoldAt = filtered.reduce(
            (latest, s) => s.soldAt > latest ? s.soldAt : latest,
            filtered[0].soldAt
          )
        }
        washTradeEditionCount++
      }
    }

    if (washTradeEditionCount > 0) {
      console.log(`[FMV-RECALC] Wash-trade filter: removed suspicious clusters from ${washTradeEditionCount} editions`)
    }

    const editionIds = [...editionSalesMap.keys()]
    console.log(`[FMV-RECALC] Processing ${editionIds.length} distinct editions`)

    // ── Step 2a-bis: Fetch tier + circulation_count for the sanity guard ─────
    // Used downstream to skip anomalous high-priced single-sale snapshots on
    // common editions while preserving legitimate Legendary/Ultimate FMVs.
    const editionMetaById = new Map<string, { tier: string | null; circulationCount: number | null }>()
    try {
      const { data: edMetaRows } = await supabaseAdmin
        .from("editions")
        .select("id, tier, circulation_count")
        .in("id", editionIds)
      for (const row of edMetaRows ?? []) {
        editionMetaById.set(String((row as any).id), {
          tier: (row as any).tier ?? null,
          circulationCount: (row as any).circulation_count ?? null,
        })
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Edition meta fetch failed (non-fatal):", err instanceof Error ? err.message : err)
    }

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

    // ── Step 3: Delete TODAY's snapshots for these editions only ─────────────
    // History matters: yesterday + earlier rows must persist so we can chart
    // price moves, market movers, and trend detection. The 20-min recalc cron
    // overwrites today's row in place.
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    const { error: deleteError, status: delStatus } = await supabaseAdmin
      .from("fmv_snapshots")
      .delete()
      .in("edition_id", editionIds)
      .gte("computed_at", todayStart.toISOString())

    if (deleteError) {
      console.error("DB write failed:", deleteError, { status: delStatus })
      return
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
      // fmv_confidence is a Postgres enum with UPPERCASE values — never use lowercase strings here.
      const baseConfidence = computeConfidence(sales.length)
      let confidence: string = escalateConfidence(baseConfidence, sales.length, prices)
      const daysSinceSale = Math.round(
        (now.getTime() - latestSoldAt.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Outlier-filtered WAP is the primary FMV signal — matches LiveToken's
      // averageWithoutWackos. Falls back to trimmed median when the cleaned
      // WAP collapses to 0 (e.g. tiny sales sets all rejected as outliers).
      const cleanWap = wapWithoutOutliers(sales, now)
      let fmv = cleanWap > 0 ? cleanWap : median
      const livetokenFmv = flowtyFmvByEdition.get(editionId)
      if (livetokenFmv && fmv > 0) {
        const ratio = livetokenFmv / fmv
        if (ratio >= 1 / 3 && ratio <= 3) {
          fmv = (fmv * 0.6) + (livetokenFmv * 0.4)
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

      // Sanity guard: a single anomalous high-priced sale (e.g. a stale wallet
      // seed or one-off transaction) can produce a wildly inflated LOW
      // confidence snapshot. Skip these for common-tier editions only — a
      // $500+ single-sale price is plausible for Legendary/Ultimate but
      // suspicious on a Common or Fandom edition.
      const edMeta = editionMetaById.get(editionId)
      const tierUpper = (edMeta?.tier ?? "").toUpperCase()
      const isCommonish = !tierUpper || tierUpper === "COMMON" || tierUpper === "FANDOM"
      if (fmv > 500 && confidence === "LOW" && sales.length === 1 && isCommonish) {
        console.warn(
          `[FMV-RECALC] Skipping anomalous LOW snapshot — editionId=${editionId} fmv=${fmv.toFixed(2)} tier=${tierUpper || "unknown"} (single-sale common guard)`
        )
        continue
      }

      insertRows.push({
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(fmv.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        wap_usd: Number(wap.toFixed(2)),
        wap_without_outliers: Number(cleanWap.toFixed(2)),
        liquidity_rating: liquidityRating(sales.length),
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

    // ── Step 5: Backfill editions with zero FMV coverage ─────────────────────
    // Query editions that have no fmv_snapshots row at all and use badge_editions
    // low_ask as a proxy to insert LOW confidence snapshots.
    let backfillCount = 0

    try {
      // Log how many editions are still missing FMV
      const { data: missingCount } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            SELECT COUNT(*) AS cnt
            FROM editions e
            LEFT JOIN fmv_snapshots fs ON fs.edition_id = e.id
            WHERE fs.edition_id IS NULL
          `,
        })
      const missingEditions = (missingCount as { cnt: number }[] | null)?.[0]?.cnt ?? "unknown"
      console.log(`[FMV-RECALC] Editions missing FMV snapshots: ${missingEditions}`)

      const { data: uncoveredEditions } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            SELECT e.id AS edition_id, e.collection_id, be.low_ask
            FROM editions e
            LEFT JOIN fmv_snapshots fs ON fs.edition_id = e.id
            LEFT JOIN badge_editions be ON be.edition_id = e.external_id
            WHERE fs.edition_id IS NULL
              AND be.low_ask IS NOT NULL
              AND be.low_ask > 0
            LIMIT 500
          `,
        })

      const rows = (uncoveredEditions as { edition_id: string; collection_id: string; low_ask: number }[] | null) ?? []

      if (rows.length > 0) {
        console.log(`[FMV-RECALC] Backfill: ${rows.length} editions with no snapshot`)

        const backfillRows = rows.map((row) => ({
          edition_id: row.edition_id,
          collection_id: row.collection_id,
          fmv_usd: Number((row.low_ask * 0.90).toFixed(2)),
          floor_price_usd: Number(Number(row.low_ask).toFixed(2)),
          wap_usd: Number((row.low_ask * 0.90).toFixed(2)),
          confidence: "LOW",
          ask_proxy_fmv: Number((row.low_ask * 0.90).toFixed(2)),
          sales_count_7d: 0,
          sales_count_30d: 0,
          days_since_sale: null,
          algo_version: ALGO_VERSION,
        }))

        // Delete-then-insert — never upsert fmv_snapshots (partitioned table).
        // Scope delete to these edition_ids + today so we don't trash history.
        const bfEditionIds = backfillRows.map((r) => r.edition_id)
        const DEL_CHUNK = 500
        for (let i = 0; i < bfEditionIds.length; i += DEL_CHUNK) {
          const slice = bfEditionIds.slice(i, i + DEL_CHUNK)
          const { error: bfDelErr } = await supabaseAdmin
            .from("fmv_snapshots")
            .delete()
            .in("edition_id", slice)
            .gte("computed_at", todayStart.toISOString())
          if (bfDelErr) console.warn("[FMV-RECALC] Backfill delete error:", bfDelErr.message)
        }

        for (let i = 0; i < backfillRows.length; i += CHUNK_SIZE) {
          const chunk = backfillRows.slice(i, i + CHUNK_SIZE)
          const { error: bfError } = await supabaseAdmin
            .from("fmv_snapshots")
            .insert(chunk)

          if (!bfError) backfillCount += chunk.length
          else console.warn("[FMV-RECALC] Backfill insert error:", bfError.message)
        }

        console.log(`[FMV-RECALC] Backfill complete: ${backfillCount} editions covered`)
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Backfill pass error:", err instanceof Error ? err.message : err)
    }

    // ── Step 5b: Historical sales fallback ───────────────────────────────────
    // Some editions have sales in sales_2026 but all older than the 30-day
    // recalc window. They never get a snapshot from Step 1 and they have no
    // badge_editions.low_ask (Step 5 backfill skips them). Compute a LOW
    // confidence FMV from whatever historical sales exist so these editions
    // show up in wallet valuations instead of silently reading as "no FMV".
    let historicalBackfillCount = 0

    try {
      const { data: histRows, error: histErr } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            SELECT
              e.id AS edition_id,
              e.collection_id,
              AVG(s.price_usd)::numeric AS avg_price,
              MIN(s.price_usd)::numeric AS min_price,
              COUNT(s.id) AS sales_count,
              MAX(s.sold_at) AS latest_sold_at
            FROM editions e
            JOIN sales s ON s.edition_id = e.id
            LEFT JOIN fmv_snapshots fs ON fs.edition_id = e.id
            WHERE fs.edition_id IS NULL
              AND s.price_usd > 0
            GROUP BY e.id, e.collection_id
            LIMIT 1000
          `,
        })

      if (histErr) {
        console.warn("[FMV-RECALC] Historical fallback query error:", histErr.message)
      } else {
        const rows = (histRows as Array<{
          edition_id: string
          collection_id: string
          avg_price: number
          min_price: number
          sales_count: number
          latest_sold_at: string
        }> | null) ?? []

        if (rows.length > 0) {
          console.log(`[FMV-RECALC] Historical fallback: ${rows.length} editions with sales but no snapshot`)

          const histInsert = rows.map((row) => {
            const avgPrice = Number(row.avg_price)
            const daysSinceSale = Math.round(
              (now.getTime() - new Date(row.latest_sold_at).getTime()) / (1000 * 60 * 60 * 24)
            )
            return {
              edition_id: row.edition_id,
              collection_id: row.collection_id,
              fmv_usd: Number(avgPrice.toFixed(2)),
              floor_price_usd: Number(Number(row.min_price).toFixed(2)),
              wap_usd: Number(avgPrice.toFixed(2)),
              wap_without_outliers: Number(avgPrice.toFixed(2)),
              liquidity_rating: liquidityRating(Number(row.sales_count)),
              confidence: "LOW",
              sales_count_7d: 0,
              sales_count_30d: 0,
              days_since_sale: daysSinceSale,
              algo_version: ALGO_VERSION,
            }
          })

          // Delete-then-insert — never upsert fmv_snapshots (partitioned table).
          const histEditionIds = histInsert.map((r) => r.edition_id)
          const DEL_CHUNK = 500
          for (let i = 0; i < histEditionIds.length; i += DEL_CHUNK) {
            const slice = histEditionIds.slice(i, i + DEL_CHUNK)
            const { error: histDelErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .delete()
              .in("edition_id", slice)
              .gte("computed_at", todayStart.toISOString())
            if (histDelErr) console.warn("[FMV-RECALC] Historical fallback delete error:", histDelErr.message)
          }

          for (let i = 0; i < histInsert.length; i += CHUNK_SIZE) {
            const chunk = histInsert.slice(i, i + CHUNK_SIZE)
            const { error: histInsertErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .insert(chunk)

            if (!histInsertErr) historicalBackfillCount += chunk.length
            else console.warn("[FMV-RECALC] Historical fallback insert error:", histInsertErr.message)
          }

          console.log(`[FMV-RECALC] Historical fallback complete: ${historicalBackfillCount} editions covered`)
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Historical fallback error:", err instanceof Error ? err.message : err)
    }

    // ── Step 6: Integer edition FMV bridge ────────────────────────────────────
    // Integer-format editions (external_id like "84:2892") exist in
    // wallet_moments_cache but have no direct sales. Bridge FMV from UUID
    // editions that share the same name + series + circulation_count.
    // Uses Postgres function bridge_integer_fmv() which handles delete + insert.
    let integerBridgeCount = 0

    try {
      const { data: bridgeResult, error: bridgeError } = await supabaseAdmin
        .rpc("bridge_integer_fmv", { p_algo_version: ALGO_VERSION })

      if (bridgeError) {
        console.warn("[FMV-RECALC] Integer bridge error:", bridgeError.message)
      } else {
        integerBridgeCount = typeof bridgeResult === "number" ? bridgeResult : 0
        console.log(`[FMV-RECALC] Integer edition FMV bridge: ${integerBridgeCount} editions covered`)
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Integer bridge error:", err instanceof Error ? err.message : err)
    }

    // ── Step 7: Stale freshness touch (force_stale=true) ──────────────────────
    // Editions whose most recent fmv_current row has not been touched in >24h
    // and that didn't pick up new sales this run will otherwise show as stale
    // indefinitely. Because WAP over a fixed window is idempotent, re-inserting
    // the current values with a fresh computed_at is a safe way to signal
    // liveness without changing any downstream consumer of FMV.
    let staleTouchCount = 0
    if (forceStale) {
      try {
        const { data: staleRows, error: staleErr } = await supabaseAdmin
          .rpc("query_sql", {
            query: `
              SELECT DISTINCT ON (fs.edition_id)
                fs.edition_id,
                fs.collection_id,
                fs.fmv_usd,
                fs.floor_price_usd,
                fs.wap_usd,
                fs.wap_without_outliers,
                fs.liquidity_rating,
                fs.confidence::text AS confidence,
                fs.ask_proxy_fmv,
                fs.sales_count_7d,
                fs.sales_count_30d,
                fs.days_since_sale
              FROM fmv_snapshots fs
              WHERE fs.computed_at < now() - interval '24 hours'
              ORDER BY fs.edition_id, fs.computed_at DESC
              LIMIT 1000
            `,
          })

        if (staleErr) {
          console.warn("[FMV-RECALC] Stale freshness query error:", staleErr.message)
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rows: any[] = (staleRows as any[] | null) ?? []
          // Skip editions already written in this run to avoid duplicate today rows.
          const skipSet = new Set<string>(insertRows.map((r) => String(r.edition_id)))
          const touchRows = rows
            .filter((r) => !skipSet.has(String(r.edition_id)))
            .map((r) => ({
              edition_id: r.edition_id,
              collection_id: r.collection_id,
              fmv_usd: r.fmv_usd,
              floor_price_usd: r.floor_price_usd,
              wap_usd: r.wap_usd,
              wap_without_outliers: r.wap_without_outliers,
              liquidity_rating: r.liquidity_rating,
              confidence: r.confidence,
              ask_proxy_fmv: r.ask_proxy_fmv,
              sales_count_7d: r.sales_count_7d,
              sales_count_30d: r.sales_count_30d,
              days_since_sale: r.days_since_sale,
              algo_version: ALGO_VERSION,
            }))

          if (touchRows.length > 0) {
            const touchEditionIds = touchRows.map((r) => r.edition_id as string)
            const DEL_CHUNK = 500
            for (let i = 0; i < touchEditionIds.length; i += DEL_CHUNK) {
              const slice = touchEditionIds.slice(i, i + DEL_CHUNK)
              const { error: touchDelErr } = await supabaseAdmin
                .from("fmv_snapshots")
                .delete()
                .in("edition_id", slice)
                .gte("computed_at", todayStart.toISOString())
              if (touchDelErr) console.warn("[FMV-RECALC] Stale touch delete error:", touchDelErr.message)
            }

            for (let i = 0; i < touchRows.length; i += CHUNK_SIZE) {
              const chunk = touchRows.slice(i, i + CHUNK_SIZE)
              const { error: touchInsertErr } = await supabaseAdmin
                .from("fmv_snapshots")
                .insert(chunk)
              if (!touchInsertErr) staleTouchCount += chunk.length
              else console.warn("[FMV-RECALC] Stale touch insert error:", touchInsertErr.message)
            }
            console.log(`[FMV-RECALC] Stale touch complete: ${staleTouchCount} editions refreshed`)
          }
        }
      } catch (err) {
        console.warn("[FMV-RECALC] Stale touch error:", err instanceof Error ? err.message : err)
      }
    }

    const hasMore = salesPage.length === limit
    const duration = Date.now() - startTime

    console.log(
      `[FMV-RECALC] Done — editions=${editionIds.length} snapshots=${snapshotsUpdated} blended=${blendedCount} askProxy=${askProxyCount} washTradeFiltered=${washTradeEditionCount} backfill=${backfillCount} historicalFallback=${historicalBackfillCount} integerBridge=${integerBridgeCount} staleTouch=${staleTouchCount} hasMore=${hasMore} duration=${duration}ms`
    )

    await fireNextPipelineStep("/api/listing-cache", chain)
    console.log(
      `[FMV-RECALC] Summary — editionsProcessed=${editionIds.length} snapshotsUpdated=${snapshotsUpdated} blended=${blendedCount} askProxy=${askProxyCount} washTradeFiltered=${washTradeEditionCount} backfill=${backfillCount} historicalFallback=${historicalBackfillCount} integerBridge=${integerBridgeCount} hasMore=${hasMore} nextOffset=${hasMore ? offset + limit : "null"} durationMs=${duration}`
    )
    } catch (e) {
      console.error("[FMV-RECALC] Fatal error:", e instanceof Error ? e.message : String(e))
    }
  })

  return NextResponse.json({
    ok: true,
    message: "FMV recalc triggered",
    triggeredAt: new Date().toISOString(),
  })
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}