import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import { applyAllFmvGuards } from "@/lib/fmv-phantom-guard"
import { computeConfidence, escalateConfidence, MIN_SALES_30D_MEDIUM } from "@/lib/fmv-confidence"

// ── FMV Recalc Route ──────────────────────────────────────────────────────────
//
// Recomputes FMV snapshots from the full 30-day sales history in the `sales`
// table, rather than relying on the batch-level prices seen during ingest.
//
// Model: trimmed median (drop bottom 10% + top 10% of prices per edition)
// WAP: recency-weighted average price (7-day half-life exponential decay)
// Window: 30 days
// Confidence: HIGH = >=7 sales/30d AND price dispersion <40%; MEDIUM >=5 sales/30d; else LOW
// algo_version: "1.7.0"
//
// Populates: fmv_usd, floor_price_usd, wap_usd, confidence,
//            sales_count_7d (30d window), sales_count_30d, days_since_sale
//
// NOTE: fmv_snapshots is a partitioned table (partition key: computed_at).
// Upsert with onConflict does not work without a unique constraint covering
// all partition columns. We use delete-then-insert instead.
//
// Pagination: by distinct edition_id ordered by MAX(sold_at) DESC, so the
// most-recently-traded editions price first. `limit` counts distinct editions,
// not sales rows. The route then fetches ALL in-window sales for that edition
// set — sales rows for a single edition must never split across pages, since
// each page does delete-then-insert and a partial page would clobber a fuller
// snapshot.
//
// Run via POST /api/fmv-recalc (token-gated, same as ingest)
// ─────────────────────────────────────────────────────────────────────────────

const ALGO_VERSION = "1.7.0"
const WINDOW_DAYS = 30
const DEFAULT_LIMIT = 2500

// Route-segment config: the paginated sweep plus the haircut pass can run
// well past the platform default, so pin the Vercel Pro maximum.
export const maxDuration = 300

// Disney Pinnacle owns its own FMV table (pinnacle_fmv_snapshots) and edition
// table (pinnacle_editions). 314 Pinnacle rows pre-dated the split and still
// live in main `editions`; without this guard, Step 5/5b/6 backfill polluted
// main fmv_snapshots with LOW-confidence duplicates of pinnacle_fmv_snapshots
// rows every 20-min tick. See docs/audits/pinnacle-editions-pollution-2026-05.md.
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

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

// Plain median of a price array (no trimming). Returns 0 for an empty array.
function medianOf(prices: number[]): number {
  if (prices.length === 0) return 0
  const s = [...prices].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

// Sales priced below this are dust — they distort medians on cheap editions and
// are excluded from every FMV computation here.
const DUST_PRICE_USD = 0.5
// A sale at or below this serial is a grail/jersey-serial that commands an
// outsized premium and must never set EDITION-level FMV when it dwarfs the rest
// of the window.
const GRAIL_SERIAL_MAX = 10

// Thin-window grail guard (audit 2026-06-09 — the "$9,000 S1 Jokić" class).
// A single grail-serial sale (e.g. serial #1 of a 3,525-print edition sold for
// $9,000) was owning an edition's FMV once its 30d window rolled down to ~2
// sales, because the outlier filter on a 2-sale set drops the CHEAP real sale
// (as <0.2x median) and keeps the grail (only 2x median). This dampener removes
// such spikes before WAP/median so the published FMV reflects the real market:
//   1. Drop dust (< $0.50).
//   2. Low-serial grail removal: while the max-priced sale is serial <= 10 and
//      > 3x the median of the rest, drop it (bounded loop for stacked grails).
//      The 3x gate spares legitimately wide high-tier spreads (e.g. a Legendary
//      whose top sale is < 3x its own median).
//   3. Generic high-outlier removal (> 5x survivor median) only when >= 3 normal
//      sales corroborate — never drag the WAP up off an un-serialed spike.
//   4. Commonish-tier safeguard: on COMMON/FANDOM/unknown-tier editions with a
//      tiny window (2-4 sales), drop a lone >5x-cheapest spike that nothing else
//      corroborates (a $9,000 vs $6 split on a common edition is poison, not
//      signal). High tiers are left untouched so serial-premium spreads survive.
// capValue = 3x the survivor median; the caller applies it only when the cleaned
// set is too thin (< 2 sales) to trust the raw WAP.
function dampenGrailSpike(
  sales: { price: number; soldAt: Date; serial: number | null }[],
  opts: { isCommonish: boolean },
): { cleaned: { price: number; soldAt: Date; serial: number | null }[]; capValue: number } {
  let cleaned = sales.filter(s => s.price >= DUST_PRICE_USD)
  if (cleaned.length <= 1) {
    const m = medianOf(cleaned.map(s => s.price))
    return { cleaned, capValue: m > 0 ? m * 3 : 0 }
  }

  // 2. Low-serial grail removal.
  for (let guard = 0; guard < 5 && cleaned.length >= 2; guard++) {
    let maxIdx = 0
    for (let i = 1; i < cleaned.length; i++) if (cleaned[i].price > cleaned[maxIdx].price) maxIdx = i
    const top = cleaned[maxIdx]
    const rest = cleaned.filter((_, i) => i !== maxIdx)
    const restMedian = medianOf(rest.map(s => s.price))
    if (top.serial != null && top.serial <= GRAIL_SERIAL_MAX && restMedian > 0 && top.price > restMedian * 3) {
      cleaned = rest
    } else {
      break
    }
  }

  // 3. Generic high-outlier removal with >= 3 corroborating normal sales.
  {
    const survivorMedian = medianOf(cleaned.map(s => s.price))
    if (survivorMedian > 0) {
      const normal = cleaned.filter(s => s.price <= survivorMedian * 5)
      if (normal.length >= 3 && normal.length < cleaned.length) cleaned = normal
    }
  }

  // 4. Commonish-tier thin-window safeguard.
  if (opts.isCommonish && cleaned.length >= 2 && cleaned.length <= 4) {
    const asc = [...cleaned].sort((a, b) => a.price - b.price)
    const lo = asc[0].price
    const hi = asc[asc.length - 1].price
    if (lo > 0 && hi > lo * 5) cleaned = asc.slice(0, asc.length - 1)
  }

  const finalMedian = medianOf(cleaned.map(s => s.price))
  return { cleaned, capValue: finalMedian > 0 ? finalMedian * 3 : 0 }
}

// FMV confidence-tier logic (computeConfidence / escalateConfidence) lives in
// lib/fmv-confidence.ts — the single source of truth shared with fmv-backfill
// so the HIGH/MEDIUM/LOW thresholds can never drift again (audit 2026-05-20 F11).

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
  const limit = Math.min(Number(body.limit ?? DEFAULT_LIMIT), 5000)

  // Resume the paginated sweep from the previous run's cursor. The cron and the
  // sales-indexer chains call this route with no explicit offset; without a
  // persisted cursor every run reprocessed page 0, so ~95% of editions were
  // never recomputed by the current algo and stayed labelled by stale /
  // cold-tail pipelines (audit 2026-05-23). The route logs cursor_after as null
  // at the end of the table, which naturally wraps the sweep back to 0. An
  // explicit body.offset still overrides (used by force_stale / manual calls).
  let offset = 0
  if (body.offset != null && Number.isFinite(Number(body.offset))) {
    offset = Number(body.offset)
  } else {
    try {
      const { data: cursorRow } = await (supabaseAdmin as any)
        .from("pipeline_runs")
        .select("cursor_after")
        .eq("pipeline", "fmv-recalc")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      const prev = Number(cursorRow?.cursor_after)
      if (Number.isFinite(prev) && prev > 0) offset = prev
    } catch (err) {
      console.warn("[FMV-RECALC] cursor read failed, starting at offset 0:", err)
    }
  }

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
      `[FMV-RECALC] Starting — offset=${offset} editionLimit=${limit} window=${WINDOW_DAYS}d since=${windowStart}`
    )
    console.log(`[FMV-RECALC] SUPABASE_SERVICE_ROLE_KEY set: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}, length: ${process.env.SUPABASE_SERVICE_ROLE_KEY?.length ?? 0}`)

    // ── Step 1a: Page through distinct edition_ids by recency ────────────────
    // Ordered by MAX(sold_at) DESC so recently-traded editions price first
    // during the initial sweep. Pagination unit is distinct editions — never
    // sales rows — because the per-page delete-then-insert flow requires an
    // edition's full sales set to land in the same chunk.
    type EditionPageRow = { edition_id: string }
    const { data: editionPage, error: editionPageError } = await (supabaseAdmin as any)
      .rpc("query_sql", {
        query: `
          SELECT edition_id
          FROM sales
          WHERE sold_at >= '${windowStart}'
            AND price_usd > 0
            AND collection_id <> '${PINNACLE_COLLECTION_ID}'
            AND edition_id IS NOT NULL
          GROUP BY edition_id
          ORDER BY MAX(sold_at) DESC NULLS LAST
          LIMIT ${limit} OFFSET ${offset}
        `,
      })

    if (editionPageError) {
      console.error("[FMV-RECALC] Edition page fetch error:", editionPageError.message)
      return
    }

    const pageEditionIds: string[] = ((editionPage as EditionPageRow[] | null) ?? [])
      .map((r) => r.edition_id)
      .filter((id): id is string => !!id)

    if (pageEditionIds.length === 0) {
      console.log(
        `[FMV-RECALC] No editions found in window at offset ${offset} — durationMs=${Date.now() - startTime}`
      )
      // If the paginated sweep walked off the end, log a null cursor so the
      // next run wraps back to offset 0 instead of getting stuck on the empty
      // page past the end.
      if (offset > 0) {
        try {
          await supabaseAdmin.rpc("log_pipeline_run", {
            p_pipeline: "fmv-recalc",
            p_started_at: new Date(startTime).toISOString(),
            p_rows_found: 0,
            p_rows_written: 0,
            p_rows_skipped: 0,
            p_ok: true,
            p_error: null,
            p_collection_slug: null,
            p_cursor_before: String(offset),
            p_cursor_after: null,
            p_extra: { algo_version: ALGO_VERSION, sweep_wrapped: true },
          })
        } catch (err) {
          console.warn("[FMV-RECALC] sweep-wrap log failed:", err)
        }
      }
      await fireNextPipelineStep("/api/listing-cache", chain)
      return
    }

    // ── Step 1b: Fetch ALL in-window sales for this edition set ──────────────
    // .in() caps around 1000 elements per PostgREST request, so chunk the IDs.
    type SaleRow = {
      edition_id: string
      collection_id: string
      price_usd: number | string
      sold_at: string
      serial_number: number | null
    }
    const salesPage: SaleRow[] = []
    const IN_CHUNK = 500
    // PostgREST caps an unlimited response at 1000 rows. A 500-edition chunk on
    // an actively-traded page routinely carries 5k–12k+ in-window sales
    // (measured 2026-06-05), so a single unpaginated `.in()` fetch silently
    // truncated each chunk to its first ~1000 rows — dropping 75–92% of sales on
    // hot pages. Editions whose sales fell past the cutoff got zero sales, fell
    // out of Step-1 pricing, and landed on the Step-5b `snap_n=0` fossil (the
    // held-wallet LOW root cause). Paginate each chunk with `.range()` until
    // exhausted so the full sales set always lands. The explicit unique
    // `.order("id")` gives a total order so range pages can't skip/duplicate
    // rows across boundaries (`sold_at` alone ties and is unsafe to paginate on).
    const SALES_PAGE = 1000
    for (let i = 0; i < pageEditionIds.length; i += IN_CHUNK) {
      const slice = pageEditionIds.slice(i, i + IN_CHUNK)
      let from = 0
      for (;;) {
        const { data: chunkSales, error: chunkErr } = await supabaseAdmin
          .from("sales")
          .select("edition_id, collection_id, price_usd, sold_at, serial_number")
          .gte("sold_at", windowStart)
          .gt("price_usd", 0)
          .neq("collection_id", PINNACLE_COLLECTION_ID)
          .in("edition_id", slice)
          .order("id", { ascending: true })
          .range(from, from + SALES_PAGE - 1)
        if (chunkErr) {
          console.error(
            `[FMV-RECALC] Sales fetch error for edition slice ${i}-${i + slice.length} range ${from}:`,
            chunkErr.message
          )
          break
        }
        const batch = (chunkSales as SaleRow[] | null) ?? []
        if (batch.length > 0) salesPage.push(...batch)
        if (batch.length < SALES_PAGE) break
        from += SALES_PAGE
      }
    }

    if (salesPage.length === 0) {
      console.warn(
        `[FMV-RECALC] Edition page returned ${pageEditionIds.length} ids but no in-window sales survived re-fetch — skipping`
      )
      await fireNextPipelineStep("/api/listing-cache", chain)
      return
    }

    // ── Step 2: Group sales by edition ────────────────────────────────────────
    const editionSalesMap = new Map<string, {
      sales: { price: number; soldAt: Date; serial: number | null }[]
      collectionId: string
      latestSoldAt: Date
    }>()

    for (const row of salesPage) {
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
    // Chunked .in() to stay under PostgREST URL limits — at limit=2500 a single
    // .in() of UUIDs blows the request size and supabase-js returns an error.
    const editionMetaById = new Map<string, { tier: string | null; circulationCount: number | null; externalId: string | null }>()
    try {
      const META_CHUNK = 500
      for (let i = 0; i < editionIds.length; i += META_CHUNK) {
        const slice = editionIds.slice(i, i + META_CHUNK)
        const { data: edMetaRows, error: edMetaErr } = await supabaseAdmin
          .from("editions")
          .select("id, tier, circulation_count, external_id")
          .in("id", slice)
        if (edMetaErr) {
          console.warn(
            `[FMV-RECALC] Edition meta chunk ${i}-${i + slice.length} error:`,
            edMetaErr.message,
          )
          continue
        }
        for (const row of edMetaRows ?? []) {
          editionMetaById.set(String((row as any).id), {
            tier: (row as any).tier ?? null,
            circulationCount: (row as any).circulation_count ?? null,
            externalId: (row as any).external_id ?? null,
          })
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] Edition meta fetch failed (non-fatal):", err instanceof Error ? err.message : err)
    }

    // ── Step 2a-ter: live ask per edition for ask-corroboration (A2) ─────────
    // edition_offers.low_ask, keyed by (collection_id, external_id). Used ONLY
    // to RAISE confidence (LOW->MEDIUM in escalateConfidence) when the sales
    // median agrees with it — never to lower a sales-based FMV (the ask is a
    // floor). Absent for editions/collections without a live ask feed (e.g.
    // All Day). TS external_ids carry a colon so they never collide with All
    // Day's bare-integer keys, making the external_id lookup unambiguous.
    const editionAskById = new Map<string, number>()
    try {
      const extIdToEditionIds = new Map<string, string[]>()
      for (const [edId, meta] of editionMetaById.entries()) {
        if (!meta.externalId) continue
        const arr = extIdToEditionIds.get(meta.externalId) ?? []
        arr.push(edId)
        extIdToEditionIds.set(meta.externalId, arr)
      }
      const extIds = [...extIdToEditionIds.keys()]
      const ASK_CHUNK = 500
      for (let i = 0; i < extIds.length; i += ASK_CHUNK) {
        const slice = extIds.slice(i, i + ASK_CHUNK)
        const { data: askRows, error: askErr } = await supabaseAdmin
          .from("edition_offers")
          .select("external_id, low_ask")
          .in("external_id", slice)
          .gt("low_ask", 0)
        if (askErr) {
          console.warn(`[FMV-RECALC] ask fetch chunk ${i} error:`, askErr.message)
          continue
        }
        for (const row of askRows ?? []) {
          const ask = Number((row as any).low_ask)
          if (!(ask > 0)) continue
          for (const edId of extIdToEditionIds.get(String((row as any).external_id)) ?? []) {
            editionAskById.set(edId, ask)
          }
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] ask fetch failed (non-fatal):", err instanceof Error ? err.message : err)
    }

    // ULTIMATE rows in fmv_snapshots are owned exclusively by recalc_ultimate_fmv
    // (the ultimate-v1 algo, which excludes special-serial sales). Drop any
    // ULTIMATE editions from this run so the legacy WAP+median path cannot
    // overwrite them with sales-inflated values.
    let ultimateSkipped = 0
    for (const edId of [...editionSalesMap.keys()]) {
      const tierUpper = String(editionMetaById.get(edId)?.tier ?? "").toUpperCase()
      if (tierUpper === "ULTIMATE") {
        editionSalesMap.delete(edId)
        ultimateSkipped++
      }
    }
    if (ultimateSkipped > 0) {
      console.log(`[FMV-RECALC] Skipped ${ultimateSkipped} ULTIMATE editions (owned by recalc_ultimate_fmv)`)
    }

    // ── Step 2a-ter: Mis-key sanity guard (serial > circulation) ─────────────
    // Drop any sale whose serial_number exceeds the edition's circulation_count.
    // A serial above the print run is physically impossible for a correctly-keyed
    // edition — it means an upstream writer mis-attributed a contiguous mint block
    // of a DIFFERENT moment to this setID:playID (the 2026-06-03 mis-key class,
    // e.g. De'Andre Hunter "Clamps" sales siphoned onto Giannis "Cosmic" 8:62 of
    // circ 49). Averaging those prices poisons the WAP. wmc is canonical for
    // nft_id→edition; until the attribution is repaired we simply exclude the
    // impossible rows from pricing here, which protects the entire mis-key class
    // regardless of cleanup status. Null-serial sales are kept (not provably
    // impossible); editions whose circulation_count is unknown/0 are untouched.
    // An edition left with zero surviving sales falls out of this run's Step-1
    // pricing (it keeps its prior snapshot / heals via the Step 5b fallback) —
    // strictly better than pricing off impossible sales.
    let miskeyDroppedSales = 0
    let miskeyEmptiedEditions = 0
    for (const [edId, edData] of [...editionSalesMap.entries()]) {
      const circ = editionMetaById.get(edId)?.circulationCount ?? null
      if (circ == null || circ <= 0) continue
      const kept = edData.sales.filter((s) => s.serial == null || s.serial <= circ)
      const dropped = edData.sales.length - kept.length
      if (dropped === 0) continue
      miskeyDroppedSales += dropped
      if (kept.length === 0) {
        editionSalesMap.delete(edId)
        miskeyEmptiedEditions++
      } else {
        edData.sales = kept
        edData.latestSoldAt = kept.reduce(
          (latest, s) => (s.soldAt > latest ? s.soldAt : latest),
          kept[0].soldAt,
        )
      }
    }
    if (miskeyDroppedSales > 0) {
      console.log(
        `[FMV-RECALC] Mis-key guard: dropped ${miskeyDroppedSales} serial>circulation sales (${miskeyEmptiedEditions} editions emptied)`,
      )
    }

    // ── Step 2a-quater: 90d window extension for thin editions ───────────────
    // Audit 2026-06-09: when an edition's 30d window rolls down to < 5 sales, a
    // single grail-serial sale can own its FMV (the "$9,000 S1 Jokić" — a circ
    // 3,525 edition whose 30d window became [$6, $9,000-for-serial-#1]). The
    // dampener (Step 4) needs a stable reference, which a 2-sale window can't
    // give. Widen the window to 90d for just the thin editions so the dampener's
    // survivor median is computed over the real cluster of cheap sales. Bounded
    // to thin editions (each has few rows by definition), re-applying the same
    // impossible-serial mis-key filter to the fetched rows.
    {
      const thinIds = [...editionSalesMap.entries()]
        .filter(([, d]) => d.sales.length < MIN_SALES_30D_MEDIUM)
        .map(([id]) => id)
      if (thinIds.length > 0) {
        const extWindowStart = new Date(
          Date.now() - 90 * 24 * 60 * 60 * 1000,
        ).toISOString()
        let extSalesFetched = 0
        let extEditionsWidened = 0
        const EXT_IN_CHUNK = 500
        const EXT_PAGE = 1000
        for (let i = 0; i < thinIds.length; i += EXT_IN_CHUNK) {
          const slice = thinIds.slice(i, i + EXT_IN_CHUNK)
          const byEdition = new Map<string, { price: number; soldAt: Date; serial: number | null }[]>()
          let from = 0
          for (;;) {
            const { data: extRows, error: extErr } = await supabaseAdmin
              .from("sales")
              .select("edition_id, price_usd, sold_at, serial_number")
              .gte("sold_at", extWindowStart)
              .gt("price_usd", 0)
              .neq("collection_id", PINNACLE_COLLECTION_ID)
              .in("edition_id", slice)
              .order("id", { ascending: true })
              .range(from, from + EXT_PAGE - 1)
            if (extErr) {
              console.warn(
                `[FMV-RECALC] 90d extension fetch error (slice ${i}, range ${from}):`,
                extErr.message,
              )
              break
            }
            const batch = (extRows as { edition_id: string; price_usd: number | string; sold_at: string; serial_number: number | null }[] | null) ?? []
            for (const r of batch) {
              const circ = editionMetaById.get(r.edition_id)?.circulationCount ?? null
              const serial = r.serial_number == null ? null : Number(r.serial_number)
              // Re-apply the impossible-serial mis-key filter to fetched rows.
              if (circ != null && circ > 0 && serial != null && serial > circ) continue
              const arr = byEdition.get(r.edition_id) ?? []
              arr.push({ price: Number(r.price_usd), soldAt: new Date(r.sold_at), serial })
              byEdition.set(r.edition_id, arr)
            }
            if (batch.length < EXT_PAGE) break
            from += EXT_PAGE
          }
          for (const [edId, widenedSales] of byEdition.entries()) {
            const data = editionSalesMap.get(edId)
            if (!data) continue
            // Only adopt the 90d set when it genuinely adds depth.
            if (widenedSales.length > data.sales.length) {
              data.sales = widenedSales
              data.latestSoldAt = widenedSales.reduce(
                (latest, s) => (s.soldAt > latest ? s.soldAt : latest),
                widenedSales[0].soldAt,
              )
              extSalesFetched += widenedSales.length
              extEditionsWidened++
            }
          }
        }
        if (extEditionsWidened > 0) {
          console.log(
            `[FMV-RECALC] 90d window extension: widened ${extEditionsWidened} thin editions (${extSalesFetched} sales)`,
          )
        }
      }
    }

    // Flowty's marketplace shut down ~2026-05-13. The former Step 2b (Flowty
    // LiveToken FMV blend) and Step 2c (floor-ask proxy) read from
    // cached_listings, which now holds only ~24 frozen multi-week-stale rows.
    // FMV is now purely sales-based (outlier-filtered WAP + trimmed-median
    // fallback). Both code paths were removed 2026-05-24.

    // ── Step 3: Delete TODAY's snapshots for these editions only ─────────────
    // History matters: yesterday + earlier rows must persist so we can chart
    // price moves, market movers, and trend detection. The 20-min recalc cron
    // overwrites today's row in place.
    // Use the post-ULTIMATE-skip set so we never delete today's ultimate-v1 row.
    // Chunked .in() — at limit=2500 a single .in() exceeds the PostgREST URL
    // cap and supabase-js silently returns deleteError, exiting the run with
    // no pipeline_runs row. Bug from 2026-05-24 (cursor ≥5000 page returned
    // ~2000 distinct editions and silently stalled the entire pipeline).
    const editionIdsToWrite = [...editionSalesMap.keys()]
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)
    {
      const DEL_CHUNK = 500
      let chunkFailed = false
      for (let i = 0; i < editionIdsToWrite.length; i += DEL_CHUNK) {
        const slice = editionIdsToWrite.slice(i, i + DEL_CHUNK)
        const { error: deleteError, status: delStatus } = await supabaseAdmin
          .from("fmv_snapshots")
          .delete()
          .in("edition_id", slice)
          .gte("computed_at", todayStart.toISOString())
        if (deleteError) {
          console.error(
            `[FMV-RECALC] Step 3 delete chunk ${i}-${i + slice.length} failed:`,
            deleteError.message,
            { status: delStatus },
          )
          chunkFailed = true
          break
        }
      }
      if (chunkFailed) {
        try {
          await supabaseAdmin.rpc("log_pipeline_run", {
            p_pipeline: "fmv-recalc",
            p_started_at: new Date(startTime).toISOString(),
            p_rows_found: editionIds.length,
            p_rows_written: 0,
            p_rows_skipped: 0,
            p_ok: false,
            p_error: "step3_delete_chunk_failed",
            p_collection_slug: null,
            p_cursor_before: String(offset),
            p_cursor_after: String(offset),
            p_extra: { algo_version: ALGO_VERSION, stage: "step3_today_purge" },
          })
        } catch {
          // best-effort — main failure is already in console
        }
        return
      }
    }

    // ── Step 4: Build and insert fresh snapshots ──────────────────────────────
    // Sales-only FMV: outlier-filtered WAP (LiveToken-style averageWithoutWackos)
    // with trimmed-median fallback. The Flowty LiveToken blend and floor-ask
    // proxy paths were removed 2026-05-24 (Flowty marketplace shutdown).
    const insertRows: Record<string, unknown>[] = []
    const blendedCount = 0
    const askProxyCount = 0

    for (const [editionId, edEntry] of editionSalesMap.entries()) {
      const { collectionId } = edEntry
      const edMeta = editionMetaById.get(editionId)
      const tierUpper = (edMeta?.tier ?? "").toUpperCase()
      const isCommonish = !tierUpper || tierUpper === "COMMON" || tierUpper === "FANDOM"

      // Thin-window grail guard (audit 2026-06-09): strip grail-serial spikes
      // before any pricing so a single $9,000 serial-#1 sale can't own the FMV
      // of a circ-3,525 common edition. Operates on the (possibly 90d-widened)
      // sale set; capValue is the 3x-survivor-median ceiling for thin results.
      const { cleaned: sales, capValue } = dampenGrailSpike(edEntry.sales, { isCommonish })
      if (sales.length === 0) continue

      const prices = sales.map(s => s.price)
      const serials = sales.map(s => s.serial)
      const latestSoldAt = sales.reduce(
        (latest, s) => (s.soldAt > latest ? s.soldAt : latest),
        sales[0].soldAt,
      )

      const median = trimmedMedian(prices)
      const wap = weightedAveragePrice(sales, now)
      const floor = Math.min(...prices)
      // fmv_confidence is a Postgres enum with UPPERCASE values — never use lowercase strings here.
      const baseConfidence = computeConfidence(sales.length)
      // serials enable the serial-residual HIGH dispersion gate; the live ask
      // (when present) enables ask-corroboration LOW->MEDIUM (see lib/fmv-confidence.ts).
      const confidence: string = escalateConfidence(
        baseConfidence, sales.length, prices, serials, editionAskById.get(editionId) ?? null,
      )
      const daysSinceSale = Math.round(
        (now.getTime() - latestSoldAt.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Outlier-filtered WAP is the primary FMV signal — matches LiveToken's
      // averageWithoutWackos. Falls back to trimmed median when the cleaned
      // WAP collapses to 0 (e.g. tiny sales sets all rejected as outliers).
      const cleanWap = wapWithoutOutliers(sales, now)
      let fmv = cleanWap > 0 ? cleanWap : median
      // When the dampened set is too thin to trust the raw WAP, cap at 3x the
      // survivor median so a residual spike can't publish an absurd price.
      if (sales.length < 2 && capValue > 0) fmv = Math.min(fmv, capValue)

      // Sanity guard: a single anomalous high-priced sale (e.g. a stale wallet
      // seed or one-off transaction) can produce a wildly inflated LOW
      // confidence snapshot. Skip these for common-tier editions only — a
      // $500+ single-sale price is plausible for Legendary/Ultimate but
      // suspicious on a Common or Fandom edition.
      if (fmv > 500 && confidence === "LOW" && sales.length === 1 && isCommonish) {
        console.warn(
          `[FMV-RECALC] Skipping anomalous LOW snapshot — editionId=${editionId} fmv=${fmv.toFixed(2)} tier=${tierUpper || "unknown"} (single-sale common guard)`
        )
        continue
      }

      insertRows.push(applyAllFmvGuards({
        edition_id: editionId,
        collection_id: collectionId,
        fmv_usd: Number(fmv.toFixed(2)),
        floor_price_usd: Number(floor.toFixed(2)),
        wap_usd: Number(wap.toFixed(2)),
        wap_without_outliers: Number(cleanWap.toFixed(2)),
        liquidity_rating: liquidityRating(sales.length),
        confidence,
        ask_proxy_fmv: null,
        sales_count_7d: sales.length,    // column name retained for schema compat; reflects 30d window
        sales_count_30d: sales.length,
        days_since_sale: daysSinceSale,
        algo_version: ALGO_VERSION,
      }))
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
              AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
              AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
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
            LEFT JOIN badge_editions be ON be.external_id = e.external_id AND be.collection_id = e.collection_id
            WHERE fs.edition_id IS NULL
              AND be.low_ask IS NOT NULL
              AND be.low_ask > 0
              AND be.low_ask <= 10000
              AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
              AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
            LIMIT 500
          `,
        })

      const rows = (uncoveredEditions as { edition_id: string; collection_id: string; low_ask: number }[] | null) ?? []

      if (rows.length > 0) {
        console.log(`[FMV-RECALC] Backfill: ${rows.length} editions with no snapshot`)

        // These editions have no snapshot at all and no in-window sales — the
        // value is purely the live TS ask × 0.90, so ASK_ONLY is the honest
        // label (was "LOW"; unified with Step 5b / drain / the guard so the
        // ask-derived class reads consistently and survives applyStaleGuard).
        const backfillRows = rows.map((row) => applyAllFmvGuards({
          edition_id: row.edition_id,
          collection_id: row.collection_id,
          fmv_usd: Number((row.low_ask * 0.90).toFixed(2)),
          floor_price_usd: Number(Number(row.low_ask).toFixed(2)),
          wap_usd: Number((row.low_ask * 0.90).toFixed(2)),
          confidence: "ASK_ONLY",
          ask_proxy_fmv: Number((row.low_ask * 0.90).toFixed(2)),
          top_shot_ask: Number(Number(row.low_ask).toFixed(2)),
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
            WITH latest_algo AS (
              SELECT DISTINCT ON (edition_id) edition_id, algo_version, confidence
              FROM fmv_snapshots
              ORDER BY edition_id, computed_at DESC
            )
            SELECT
              e.id AS edition_id,
              e.collection_id,
              AVG(s.price_usd)::numeric AS avg_price,
              MIN(s.price_usd)::numeric AS min_price,
              COUNT(s.id) AS sales_count,
              MAX(s.sold_at) AS latest_sold_at,
              MAX(la.confidence::text) AS prev_confidence,
              MAX(be.low_ask) FILTER (WHERE be.low_ask > 0 AND be.low_ask <= 10000) AS low_ask
            FROM editions e
            JOIN sales s ON s.edition_id = e.id
            LEFT JOIN latest_algo la ON la.edition_id = e.id
            LEFT JOIN badge_editions be ON be.external_id = e.external_id AND be.collection_id = e.collection_id
            -- Admit editions with no snapshot, or a non-1.7.x snapshot, OR a 1.7.x
            -- snapshot that is currently NO_DATA (the F5 / corrected-D3 recovery):
            -- ~38 editions that have sales but were stamped NO_DATA by an earlier
            -- empty-window pass and then frozen out by the "skip 1.7.x" guard.
            -- Scoped to confidence='NO_DATA' ONLY — a broader relax would re-admit
            -- (and risk re-clobbering) good 1.7.x HIGH/MEDIUM rows, the 2026-05-30
            -- Step 6 self-perpetuating-cycle class.
            WHERE (la.edition_id IS NULL OR la.algo_version NOT LIKE '1.7.%' OR la.confidence = 'NO_DATA')
              AND s.price_usd > 0
              AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
              AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
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
          prev_confidence: string | null
          low_ask: number | string | null
        }> | null) ?? []

        if (rows.length > 0) {
          console.log(`[FMV-RECALC] Historical fallback: ${rows.length} editions with sales but no snapshot`)

          const histInsert = rows.map((row) => {
            const avgPrice = Number(row.avg_price)
            const daysSinceSale = Math.round(
              (now.getTime() - new Date(row.latest_sold_at).getTime()) / (1000 * 60 * 60 * 24)
            )
            const freshAsk = row.low_ask == null ? 0 : Number(row.low_ask)

            // Source-side ask preference: an edition with no in-window (30d)
            // sales would otherwise be priced off a 30+-day-old WAP — labelled
            // LOW (then flipped STALE by applyStaleGuard) or STALE outright.
            // When a fresh TS marketplace ask exists (badge_editions.low_ask,
            // refreshed every 6h, already filtered to 0 < ask <= 10000 in the
            // query), price it ASK_ONLY at ask × 0.90 instead — the same proxy
            // the Step 5 backfill and drain_fmv_cold_tail use. The >= 30 gate
            // (≡ sales_count_30d = 0, the DB guard's stale-30d rescue domain)
            // makes the 2026-05-31 thin-sales-guard stopgap durable at the
            // source: the guard now skips ASK_ONLY rows, so there is no
            // STALE→ASK_ONLY re-clobber churn. It also covers the sub-$200
            // stale-WAP class the guard's fmv_usd > 200 filter could never
            // reach (e.g. LeBron Base S1 2:133 = $78 WAP vs $945 ask). No >200
            // gate here. Editions with a genuine in-window sale (< 30d) fall
            // through to sales pricing and are repriced by the main sweep.
            if (daysSinceSale >= 30 && freshAsk > 0) {
              const askFmv = Number((freshAsk * 0.90).toFixed(2))
              return applyAllFmvGuards({
                edition_id: row.edition_id,
                collection_id: row.collection_id,
                fmv_usd: askFmv,
                floor_price_usd: Number(freshAsk.toFixed(2)),
                wap_usd: askFmv,
                wap_without_outliers: askFmv,
                ask_proxy_fmv: askFmv,
                top_shot_ask: Number(freshAsk.toFixed(2)),
                liquidity_rating: liquidityRating(Number(row.sales_count)),
                confidence: "ASK_ONLY",
                sales_count_7d: 0,
                sales_count_30d: 0,
                days_since_sale: daysSinceSale,
                algo_version: ALGO_VERSION,
              })
            }

            // F5 recovery rows (previously frozen at NO_DATA) carry an honest
            // sales-derived label: SALES_ONLY when enough sales exist to trust the
            // average, else STALE — never LOW (LOW implies a healthy in-window
            // read these don't have). The pre-existing non-1.7.x population keeps
            // its original daysSinceSale>=60 ? STALE : LOW behavior unchanged.
            const wasNoData = row.prev_confidence === "NO_DATA"
            const histConfidence = wasNoData
              ? (Number(row.sales_count) >= MIN_SALES_30D_MEDIUM ? "SALES_ONLY" : "STALE")
              : (daysSinceSale >= 60 ? "STALE" : "LOW")

            return applyAllFmvGuards({
              edition_id: row.edition_id,
              collection_id: row.collection_id,
              fmv_usd: Number(avgPrice.toFixed(2)),
              floor_price_usd: Number(Number(row.min_price).toFixed(2)),
              wap_usd: Number(avgPrice.toFixed(2)),
              wap_without_outliers: Number(avgPrice.toFixed(2)),
              liquidity_rating: liquidityRating(Number(row.sales_count)),
              // Honesty gate: if the edition hasn't traded in 60+ days (and has
              // no fresh ask, handled above), label it STALE rather than LOW —
              // single-sale WAP from 2+ months ago is unreliable signal, not
              // healthy low-confidence pricing.
              confidence: histConfidence,
              sales_count_7d: 0,
              sales_count_30d: 0,
              days_since_sale: daysSinceSale,
              algo_version: ALGO_VERSION,
            })
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

    // ── Step 5c: edition_offers ASK fallback (zero-sales NO_DATA tail) ────────
    // The real no-market NO_DATA tail after the dupe cleanup is tiny (~580
    // canonical TS editions), and ~480 of them HAVE a live ask in
    // edition_offers.low_ask (the near-complete TS ask feed from the OffersV2
    // indexer) yet are stuck NO_DATA: they have zero sales (so Step 5b's
    // `JOIN sales` never admits them) and they already carry a NO_DATA snapshot
    // (so Step 5's `fs.edition_id IS NULL` never admits them either). Step 5/5b
    // only read badge_editions.low_ask, which does not cover this set. Add
    // edition_offers as an ASK source so these read as honest ASK_ONLY at the
    // standard ×0.90 haircut instead of NO_DATA. The handful with no ask at all
    // (and the 3 with an absurd >$10k ask) stay honest NO_DATA — never estimated.
    //
    // Scoped to zero-sales editions only: an edition with ANY sale heals to a
    // sales-based label via Step 5b (strictly better than ask-only), so we must
    // not steal it here. The same ≤$10k ceiling as the badge/Step-5b ask path
    // guards against the $5M garbage asks present in edition_offers. Collection-
    // agnostic; in practice only Top Shot has populated low_ask (All Day's
    // edition_offers carries the bid side, highest_offer, not low_ask).
    let askOffersBackfillCount = 0
    try {
      const { data: askOnlyRows, error: askOnlyErr } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            WITH latest AS (
              SELECT DISTINCT ON (edition_id) edition_id, confidence
              FROM fmv_snapshots
              ORDER BY edition_id, computed_at DESC
            )
            SELECT e.id AS edition_id, e.collection_id, eo.low_ask
            FROM editions e
            JOIN edition_offers eo
              ON eo.external_id = e.external_id
             AND eo.collection_id = e.collection_id
            LEFT JOIN latest l ON l.edition_id = e.id
            WHERE (l.edition_id IS NULL OR l.confidence = 'NO_DATA')
              AND eo.low_ask > 0
              AND eo.low_ask <= 10000
              AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
              AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
              AND NOT EXISTS (
                SELECT 1 FROM sales s
                WHERE s.edition_id = e.id AND s.price_usd > 0
              )
            LIMIT 1000
          `,
        })

      if (askOnlyErr) {
        console.warn("[FMV-RECALC] edition_offers ASK fallback query error:", askOnlyErr.message)
      } else {
        const rows = (askOnlyRows as { edition_id: string; collection_id: string; low_ask: number | string }[] | null) ?? []
        if (rows.length > 0) {
          console.log(`[FMV-RECALC] edition_offers ASK fallback: ${rows.length} zero-sales NO_DATA editions with a live ask`)

          const askRows = rows.map((row) => {
            const ask = Number(row.low_ask)
            const askFmv = Number((ask * 0.90).toFixed(2))
            return applyAllFmvGuards({
              edition_id: row.edition_id,
              collection_id: row.collection_id,
              fmv_usd: askFmv,
              floor_price_usd: Number(ask.toFixed(2)),
              wap_usd: askFmv,
              wap_without_outliers: askFmv,
              ask_proxy_fmv: askFmv,
              top_shot_ask: Number(ask.toFixed(2)),
              liquidity_rating: 0,
              confidence: "ASK_ONLY",
              sales_count_7d: 0,
              sales_count_30d: 0,
              days_since_sale: null,
              algo_version: ALGO_VERSION,
            })
          })

          // Delete-then-insert — never upsert fmv_snapshots (partitioned table).
          const askEditionIds = askRows.map((r) => r.edition_id)
          const DEL_CHUNK = 500
          for (let i = 0; i < askEditionIds.length; i += DEL_CHUNK) {
            const slice = askEditionIds.slice(i, i + DEL_CHUNK)
            const { error: askDelErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .delete()
              .in("edition_id", slice)
              .gte("computed_at", todayStart.toISOString())
            if (askDelErr) console.warn("[FMV-RECALC] ASK fallback delete error:", askDelErr.message)
          }

          for (let i = 0; i < askRows.length; i += CHUNK_SIZE) {
            const chunk = askRows.slice(i, i + CHUNK_SIZE)
            const { error: askInsErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .insert(chunk)
            if (!askInsErr) askOffersBackfillCount += chunk.length
            else console.warn("[FMV-RECALC] ASK fallback insert error:", askInsErr.message)
          }

          console.log(`[FMV-RECALC] edition_offers ASK fallback complete: ${askOffersBackfillCount} editions covered`)
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] edition_offers ASK fallback error:", err instanceof Error ? err.message : err)
    }

    // ── Step 6: Stale freshness touch (force_stale=true) ──────────────────────
    // Editions whose most recent fmv_current row has not been touched in >24h
    // and that didn't pick up new sales this run will otherwise show as stale
    // indefinitely. Re-inserting the current values with a fresh computed_at is
    // a safe liveness signal — BUT ONLY for editions that have no in-window
    // sales. The original premise "WAP over a fixed window is idempotent" is
    // only true when there is no trading: as soon as an edition has sales in the
    // last 30 days, its WAP is NOT idempotent (the window rolls, new sales land),
    // and re-stamping the prior snapshot forward as fake-fresh `1.7.0` pins the
    // edition to a stale value/confidence forever. That is the Cause-B "fossil"
    // bug (2026-06-04): actively-traded editions (e.g. Chaz Lanier 219:7409 with
    // 200+ sales/30d frozen at LOW $6.76 sales_count_30d=0; Neemias Queta 218:7778
    // frozen at MEDIUM $6.40 while real sales collapsed to ~$0.39) kept alive as
    // fresh by this touch, never re-priced by Step 1.
    //
    // Fix: the `recent_traded` anti-join excludes ANY edition with an in-window
    // sale from the stale-touch — those are owned by Step 1's sales recompute
    // (which pages by MAX(sold_at) DESC, so traded editions price first). Step 6
    // now only refreshes genuinely-cold editions (no recent sales), the exact
    // population for which the idempotency premise actually holds. This is
    // collection-agnostic, so it covers Top Shot AND All Day in one shared fix.
    let staleTouchCount = 0
    if (forceStale) {
      try {
        const { data: staleRows, error: staleErr } = await supabaseAdmin
          .rpc("query_sql", {
            query: `
              WITH latest AS (
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
                  fs.days_since_sale,
                  fs.computed_at
                FROM fmv_snapshots fs
                ORDER BY fs.edition_id, fs.computed_at DESC
              ),
              recent_traded AS (
                SELECT edition_id
                FROM sales
                WHERE sold_at >= now() - interval '30 days'
                  AND price_usd > 0
                  AND edition_id IS NOT NULL
                GROUP BY edition_id
              )
              SELECT
                l.edition_id,
                l.collection_id,
                l.fmv_usd,
                l.floor_price_usd,
                l.wap_usd,
                l.wap_without_outliers,
                l.liquidity_rating,
                l.confidence,
                l.ask_proxy_fmv,
                l.sales_count_7d,
                l.sales_count_30d,
                l.days_since_sale
              FROM latest l
              JOIN editions e ON e.id = l.edition_id
              LEFT JOIN recent_traded rt ON rt.edition_id = l.edition_id
              WHERE l.computed_at < now() - interval '24 hours'
                -- Audit 2026-06-09: only re-stamp HIGH/MEDIUM editions. Touching
                -- LOW/ASK_ONLY rows made ask-derived poison immortal (a $550
                -- troll-ask ASK_ONLY and a $9,000 single-grail LOW were kept
                -- fake-fresh as 1.7.0 forever, and it hid true staleness from
                -- every freshness metric). LOW/ASK_ONLY/SALES_ONLY/STALE now age
                -- visibly until a real recompute (Step 1 / Step 5b) reprices them.
                AND l.confidence IN ('HIGH','MEDIUM')
                AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
                AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
                AND rt.edition_id IS NULL
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
            .map((r) => applyAllFmvGuards({
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

    // ── Step 8: Thin-sale haircut on freshly-recalc'd collections ────────────
    // fmv_apply_thin_sale_haircut filters internally to LOW + ASK_ONLY, so
    // HIGH/MEDIUM rows we just wrote are untouched. Calling it inline here
    // means newly-computed ASK-only FMVs get haircut on the same run instead
    // of drifting back to floor between recalcs. Scope to the collection set
    // we actually saw sales for; if the batch was empty (early-return path
    // wouldn't reach here), fall back to NULL = all collections.
    let haircutRowsTotal = 0
    let haircutCollectionsRun = 0
    try {
      const collectionIds = new Set<string>()
      for (const { collectionId } of editionSalesMap.values()) {
        if (collectionId) collectionIds.add(collectionId)
      }
      const targets: (string | null)[] =
        collectionIds.size > 0 ? [...collectionIds] : [null]

      for (const cid of targets) {
        const { data: hc, error: hcErr } = await supabaseAdmin.rpc(
          "fmv_apply_thin_sale_haircut",
          { p_collection_id: cid, p_dry_run: false }
        )
        if (hcErr) {
          console.warn(
            `[FMV-RECALC] Haircut RPC error (cid=${cid ?? "all"}): ${hcErr.message}`
          )
          continue
        }
        const row = Array.isArray(hc) && hc.length > 0 ? hc[0] : null
        const haircut = Number(row?.rows_haircut ?? 0)
        haircutRowsTotal += haircut
        haircutCollectionsRun += 1
        console.log(
          `[FMV-RECALC] Haircut applied cid=${cid ?? "all"} examined=${row?.rows_examined ?? 0} haircut=${haircut} dollars_removed=${row?.total_dollars_removed ?? 0}`
        )
      }
    } catch (err) {
      console.warn(
        "[FMV-RECALC] Haircut pass error:",
        err instanceof Error ? err.message : err
      )
    }

    // ── Step 9: Thin-sales guard post-pass ───────────────────────────────────
    // apply_fmv_thin_sales_guard is the SECDEF cleanup that detects mis-
    // calibrated FMVs (thin-sales-with-high-fmv, stale-30d-no-ask, etc.)
    // and writes capped replacement rows into fmv_snapshots. Calling it
    // immediately after the recalc keeps the cap audit trail aligned with
    // each run's writes. Failures are non-fatal — the run is still useful
    // even if the guard times out or errors.
    let thinSalesCaps: {
      thin_sales_count?: number
      stale_count?: number
      common_outlier_count?: number
      total_caps_applied?: number
    } | null = null
    try {
      const { data: guardResult, error: guardErr } = await supabaseAdmin.rpc(
        "apply_fmv_thin_sales_guard",
        { p_mode: "live" }
      )
      if (guardErr) {
        console.warn(
          "[FMV-RECALC] thin-sales guard error (non-fatal):",
          guardErr.message
        )
      } else {
        const row =
          Array.isArray(guardResult) && guardResult.length > 0
            ? (guardResult[0] as Record<string, unknown>)
            : (guardResult as Record<string, unknown> | null)
        if (row) {
          thinSalesCaps = {
            thin_sales_count: Number(row.thin_sales_count ?? 0),
            stale_count: Number(row.stale_count ?? 0),
            common_outlier_count: Number(row.common_outlier_count ?? 0),
            total_caps_applied: Number(row.total_caps_applied ?? 0),
          }
          console.log(
            `[FMV-RECALC] thin-sales guard applied — thin=${thinSalesCaps.thin_sales_count} stale=${thinSalesCaps.stale_count} commonOutlier=${thinSalesCaps.common_outlier_count} totalCaps=${thinSalesCaps.total_caps_applied}`
          )
        }
      }
    } catch (err) {
      console.warn(
        "[FMV-RECALC] thin-sales guard threw (non-fatal):",
        err instanceof Error ? err.message : err
      )
    }

    // hasMore is keyed on the distinct-edition page size — never the sales
    // count — since pagination unit is distinct editions.
    const hasMore = pageEditionIds.length === limit
    const duration = Date.now() - startTime

    console.log(
      `[FMV-RECALC] Done — editions=${editionIds.length} snapshots=${snapshotsUpdated} blended=${blendedCount} askProxy=${askProxyCount} washTradeFiltered=${washTradeEditionCount} backfill=${backfillCount} historicalFallback=${historicalBackfillCount} askOffersFallback=${askOffersBackfillCount} staleTouch=${staleTouchCount} haircut=${haircutRowsTotal} thinSalesCaps=${thinSalesCaps?.total_caps_applied ?? 0} hasMore=${hasMore} duration=${duration}ms`
    )

    // Surface the run + cap counts in pipeline_runs.extra so /admin
    // pipeline-health and the future fmv-health dashboard can read them
    // without parsing logs. Best-effort — never throw back into the run.
    try {
      await supabaseAdmin.rpc("log_pipeline_run", {
        p_pipeline: "fmv-recalc",
        p_started_at: new Date(startTime).toISOString(),
        p_rows_found: editionIds.length,
        p_rows_written: snapshotsUpdated,
        p_rows_skipped: 0,
        p_ok: true,
        p_error: null,
        p_collection_slug: null,
        p_cursor_before: String(offset),
        p_cursor_after: hasMore ? String(offset + limit) : null,
        p_extra: {
          algo_version: ALGO_VERSION,
          duration_ms: duration,
          blended: blendedCount,
          ask_proxy: askProxyCount,
          wash_trade_filtered: washTradeEditionCount,
          backfill: backfillCount,
          historical_fallback: historicalBackfillCount,
          ask_offers_fallback: askOffersBackfillCount,
          stale_touch: staleTouchCount,
          haircut_rows: haircutRowsTotal,
          haircut_collections_run: haircutCollectionsRun,
          thin_sales_caps: thinSalesCaps,
        },
      })
    } catch (err) {
      console.warn(
        "[FMV-RECALC] log_pipeline_run failed (non-fatal):",
        err instanceof Error ? err.message : err
      )
    }

    await fireNextPipelineStep("/api/listing-cache", chain)
    console.log(
      `[FMV-RECALC] Summary — editionsProcessed=${editionIds.length} snapshotsUpdated=${snapshotsUpdated} blended=${blendedCount} askProxy=${askProxyCount} washTradeFiltered=${washTradeEditionCount} backfill=${backfillCount} historicalFallback=${historicalBackfillCount} haircutRows=${haircutRowsTotal} haircutCollectionsRun=${haircutCollectionsRun} hasMore=${hasMore} nextOffset=${hasMore ? offset + limit : "null"} durationMs=${duration}`
    )
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e)
      console.error("[FMV-RECALC] Fatal error:", errMsg)
      // Surface the failure in pipeline_runs so /admin/pipeline-health and
      // sentinel alerts can detect a silent stall. Before this, a throw in
      // after() left console.error as the only signal and the pipeline went
      // dark for 16h on 2026-05-24 with zero pipeline_runs evidence.
      try {
        await supabaseAdmin.rpc("log_pipeline_run", {
          p_pipeline: "fmv-recalc",
          p_started_at: new Date(startTime).toISOString(),
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: errMsg.slice(0, 500),
          p_collection_slug: null,
          p_cursor_before: String(offset),
          p_cursor_after: String(offset),
          p_extra: { algo_version: ALGO_VERSION, stage: "fatal_after_throw" },
        })
      } catch {
        // best-effort — main error already in console
      }
    }
  })

  return NextResponse.json({
    ok: true,
    message: "FMV recalc triggered",
    triggeredAt: new Date().toISOString(),
    haircut: "scheduled (LOW + ASK_ONLY only; row count in [FMV-RECALC] Summary log)",
  })
}

// Allow GET for browser testing
export async function GET(req: NextRequest) {
  return POST(req)
}