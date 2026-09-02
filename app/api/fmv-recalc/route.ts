import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"
import { applyAllFmvGuards, capFmvAtCheapestAsk } from "@/lib/fmv-phantom-guard"
import { computeConfidence, escalateConfidence, gateHighToRecentVolume, MIN_SALES_30D_MEDIUM } from "@/lib/fmv-confidence"
import { rpcWithRetry, queryWithRetry } from "@/lib/analytics/rpc-with-retry"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"

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
// Populates: fmv_usd, floor_price_usd, asp_usd, confidence,
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

// ── Page size MUST stay below PostgREST's 1000-row cap ───────────────────────
// 2026-08-03: DEFAULT_LIMIT was 2500. `fmv_recalc_edition_page` is called over
// PostgREST, which clamps any RPC result set to db-max-rows = 1000, so the route
// asked for 2500 and silently received 1000. `hasMore` keys on
// `pageEditionIds.length === limit` (1000 !== 2500) → false → cursor_after=null
// → every run restarted at offset 0. Measured: 20h of runs all logged
// cursor_before='0', cursor_after=NULL, and only ~1,000 of the 11,606 editions
// with a sale in the window were EVER recomputed — 74% of the actively-traded
// catalogue was never repriced by the current algo, with ok=true throughout.
// This is the SAME 1000-row cap the .in() chunk sites were already guarded
// against (see __tests__/invariants-fmv-recalc-chunking.test.ts); the page fetch
// itself was never covered.
//
// 500 (not 900) because runs already average 181s against maxDuration=300 and
// 23.6% of invocations (95 of ~402 in 72h) are killed at the wall before writing
// a terminal row. A killed run logs no cursor_after, so the next run retries the
// SAME offset — harmless while the cursor was pinned at 0, but once it advances a
// systematically-slow page could re-stall the sweep. Halving the per-page work
// buys headroom. 11,606 / 500 ≈ 24 pages ≈ 5h per full sweep at ~5.6 runs/hour.
const DEFAULT_LIMIT = 500
// Hard ceiling for an explicit body.limit — must stay < 1000 or the truncation
// above silently returns and the cursor stops advancing again.
const MAX_PAGE_LIMIT = 900
// PostgREST's row cap. Only used to detect that we hit it (tripwire below).
const POSTGREST_ROW_CAP = 1000

// Route-segment config: the paginated sweep plus the haircut pass can run
// well past the platform default, so pin the Vercel Pro maximum.
export const maxDuration = 300

// Step-1 retry budgets. ⚠ Sized against `maxDuration = 300`, NOT chosen for
// comfort: a run that spends its whole budget retrying and then succeeds is worse
// than one that fails fast, because it gets killed at the wall having written
// nothing either way. Step 1a RETURNS on failure so it can never stack with 1b;
// a run that proceeds therefore risks at most STEP1B_BUDGET_MS of retrying on top
// of a sweep that averages ~194 s.
// ⚠ The BACKOFF, not the retry, is the load-bearing part — rpc-with-retry's
// default is ~250 ms total, which lands entirely inside a saturation spell that
// lasts seconds. See queryWithRetry's header.
const STEP1_RETRY_ATTEMPTS = 3
const STEP1_RETRY_BASE_MS = 1_500 // → 1.5 s + 6 s of backoff across 3 attempts
const STEP1A_BUDGET_MS = 90_000
const STEP1B_BUDGET_MS = 120_000

// Disney Pinnacle owns its own FMV table (pinnacle_fmv_snapshots) and edition
// table (pinnacle_editions). 314 Pinnacle rows pre-dated the split and still
// live in main `editions`; without this guard, Step 5/5b/6 backfill polluted
// main fmv_snapshots with LOW-confidence duplicates of pinnacle_fmv_snapshots
// rows every 20-min tick. See docs/audits/pinnacle-editions-pollution-2026-05.md.
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// WAP half-life in seconds — 7 days means a sale from 7 days ago
// carries ~37% of the weight of a sale from today.
const WAP_HALF_LIFE_SECONDS = 7 * 24 * 60 * 60

// FMV price-math primitives (trimmedMedian / weightedAveragePrice / liquidityRating /
// wapWithoutOutliers / medianOf / lowSerialThreshold / isPremiumSerial / dampenGrailSpike)
// + their tuning constants live in lib/fmv-recalc-math.ts so they can be unit-tested.
// Behavior is identical to the previous inline definitions.
import {
  trimmedMedian,
  weightedAveragePrice,
  liquidityRating,
  wapWithoutOutliers,
  medianOf,
  isPremiumSerial,
  dampenGrailSpike,
  TYPICAL_SERIAL_MIN,
} from "@/lib/fmv-recalc-math"

// ── Serial-aware base FMV (2026-06-20) ───────────────────────────────────────
// The edition-level base FMV must reflect a TYPICAL serial, not the average of
// all serials. Low/special serials carry a large collector premium; averaging
// them in pushes the base ABOVE what a typical serial (and the floor ask) trades
// at, producing fake "deals" (FMV > low ask) on the deal board + alerts. The
// proven case (Trevor, 2026-06-20): Nolan Traore "Metallic Gold LE" (233:8121,
// circ 164) read FMV $45.83 vs a $23 floor ask — its typical serials (>20) trade
// ~$23 (= the ask) while serials <=20 trade ~$39, and three recent low-serial
// sales dragged the recency-WAP to $45.83.
//
// Fix: exclude PREMIUM-serial sales from the central value only. A premium serial
// is #1, the perfect/last-mint (serial == circulation), the player's jersey
// number, or a low serial below a circulation-scaled threshold. The low-serial
// PREMIUM itself is a SEPARATE layer (serial_fmv_*); the base writer just stops
// folding it into the typical floor. Confidence/volume and the serial-residual
// HIGH dispersion gate keep using the FULL sale set — that gate WANTS the serial
// structure (lib/fmv-confidence.ts) — so only the central VALUE is serial-aware.
// When the typical-serial subset is too thin to trust (low-circ / grail-only
// editions) the base falls back to the full cleaned set, so no real edition
// loses pricing or drops to NO_DATA.
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
  // Clamp to [1, MAX_PAGE_LIMIT]. Number.isFinite guard, not a bare Math.min:
  // `Math.min(NaN, 900)` is NaN, and a NaN limit reaches the RPC as a null
  // p_limit — the same NaN-clamp class already swept out of /api/edition-history,
  // /api/recent-sales and the /insights routes. Ceiling is MAX_PAGE_LIMIT (was
  // 5000) so a manual call can never re-trigger the PostgREST truncation.
  const rawLimit = Number(body.limit ?? DEFAULT_LIMIT)
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.trunc(rawLimit), 1), MAX_PAGE_LIMIT)
    : DEFAULT_LIMIT

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
    // 2026-06-11 (Item 3): maxDuration hard-kill heartbeat. fmv-recalc's only
    // failure-visibility is the end-of-run log_pipeline_run; a run killed at the
    // 300s cap (the 21:28/21:30Z 06-10 saturation kills, which did real work per
    // Vercel logs but wrote no pipeline_runs row) dies before any terminal log
    // and is invisible. Drop a 'started' marker at after() entry into a SEPARATE
    // pipeline name (so the real fmv-recalc cadence / detect_stalled / cursor-
    // resume signals, all keyed on pipeline='fmv-recalc', are untouched; ok stays
    // true so no ok=false alert fires).
    //
    // Kills are detected by CORRELATION, not by a finalize step — a finally after
    // a heavy after() body does not run reliably under Vercel's lambda lifecycle
    // (the post-completion fireNextPipelineStep await can consume the remaining
    // execution window before finally), and a normal run already writes a terminal
    // fmv-recalc row at the SAME started_at. A maxDuration kill is the one case
    // that writes NO terminal fmv-recalc row, so:
    //   SELECT hb.started_at FROM pipeline_runs hb
    //   WHERE hb.pipeline='fmv-recalc-heartbeat'
    //     AND hb.started_at < now() - interval '10 minutes'
    //     AND NOT EXISTS (SELECT 1 FROM pipeline_runs fr
    //       WHERE fr.pipeline='fmv-recalc'
    //         AND fr.started_at BETWEEN hb.started_at - interval '5 s'
    //                              AND hb.started_at + interval '5 s');  -- = kills
    // Telemetry only.
    //
    // 2026-08-20: the hand-rolled insert that stood here moved to
    // `lib/pipeline/heartbeat.ts`. It was one of FIVE copies of this contract and
    // no two agreed — this one wrote `rows_found`/`rows_written` as the column
    // default 0 across all 564 of its live rows, which is the fabricated-
    // measurement shape (`?? 0` on a count) that made a live pipeline read as
    // inert in the 2026-08-16 retirement sweep. The helper sends them NULL. It
    // also keeps the `finished_at` pin that landed here on 2026-08-15 — the
    // reason is now in the helper's own comment rather than repeated per site.
    await writeInvocationHeartbeat({
      pipeline: "fmv-recalc",
      startedAtMs: startTime,
      cursor: String(offset),
      extra: { offset, edition_limit: limit, max_duration_s: 300 },
    })
    try {

    const windowStart = new Date(
      Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString()

    console.log(
      `[FMV-RECALC] Starting — offset=${offset} editionLimit=${limit} window=${WINDOW_DAYS}d since=${windowStart}`
    )
    console.log(`[FMV-RECALC] SUPABASE_SERVICE_ROLE_KEY set: ${!!process.env.SUPABASE_SERVICE_ROLE_KEY}`)

    // ── Step 1a: Page through distinct edition_ids by recency ────────────────
    // Ordered by MAX(sold_at) DESC so recently-traded editions price first
    // during the initial sweep. Pagination unit is distinct editions — never
    // sales rows — because the per-page delete-then-insert flow requires an
    // edition's full sales set to land in the same chunk.
    type EditionPageRow = { edition_id: string }
    // 2026-07-11: moved off the generic query_sql (service_role 30s
    // statement_timeout) into a dedicated SECURITY DEFINER fn with a
    // function-local statement_timeout=120s. The 30-day GROUP BY edition_id /
    // ORDER BY MAX(sold_at) scan of ~110K sales rows was crossing 30s under
    // cold cache (~31s cold vs <0.2s warm), producing intermittent
    // "edition_page_fetch: canceling statement due to statement timeout"
    // failures. See migration audit_20260711_fmv_recalc_edition_page_fn_120s_timeout
    // + the covering index idx_sales_2026_fmv_recalc_window.
    // 2026-08-16: retried, because a failure here discards the ENTIRE run before
    // the cursor can advance — 3 of the 17 consecutive zero-row runs in the
    // 06:48–19:10Z outage died right here on "Timed out acquiring connection from
    // connection pool", at 45–139 s against a 300 s ceiling. The batch-sized
    // backoff (not the page-render default of ~250 ms) is the load-bearing part;
    // see queryWithRetry's header for why a background sweep and a page render
    // take opposite answers on whether to retry under saturation.
    const { data: editionPage, error: editionPageError } = await rpcWithRetry<
      EditionPageRow[]
    >(
      supabaseAdmin as never,
      "fmv_recalc_edition_page",
      {
        p_window_start: windowStart,
        p_pinnacle_collection_id: PINNACLE_COLLECTION_ID,
        p_limit: limit,
        p_offset: offset,
      },
      { attempts: STEP1_RETRY_ATTEMPTS, baseDelayMs: STEP1_RETRY_BASE_MS, timeoutMs: STEP1A_BUDGET_MS }
    )

    if (editionPageError) {
      console.error("[FMV-RECALC] Edition page fetch error:", editionPageError.message)
      // 2026-06-10: this early return previously skipped log_pipeline_run entirely,
      // so saturation-era Step-1a timeouts produced SILENT unlogged runs and
      // get_pipeline_alerts fired a false "cron_silent" while the cron was firing.
      // Every exit path must log.
      try {
        await supabaseAdmin.rpc("log_pipeline_run", {
          p_pipeline: "fmv-recalc",
          p_started_at: new Date(startTime).toISOString(),
          p_rows_found: 0,
          p_rows_written: 0,
          p_rows_skipped: 0,
          p_ok: false,
          p_error: `edition_page_fetch: ${editionPageError.message}`,
          p_collection_slug: null,
          p_cursor_before: String(offset),
          p_cursor_after: String(offset),
          p_extra: { algo_version: ALGO_VERSION, stage: "step1a_edition_page" },
        })
      } catch (logErr) {
        console.warn("[FMV-RECALC] step1a-fail log failed:", logErr)
      }
      return
    }

    const rawPageRows = (editionPage as EditionPageRow[] | null) ?? []

    // TRIPWIRE — the 2026-08-03 stall was invisible because a truncated page is
    // indistinguishable from a short final page: both just make hasMore false.
    // If the page comes back AT the cap while we asked for more, PostgREST
    // truncated us and the cursor can no longer advance. Say so loudly rather
    // than letting it be inferred from a flat cursor 20 hours later.
    if (rawPageRows.length >= POSTGREST_ROW_CAP && limit > POSTGREST_ROW_CAP) {
      console.error(
        `[FMV-RECALC] PostgREST row cap hit: requested limit=${limit}, got ${rawPageRows.length}. ` +
          `hasMore will read false and the sweep cursor will reset to 0 every run. ` +
          `Lower DEFAULT_LIMIT/MAX_PAGE_LIMIT below ${POSTGREST_ROW_CAP}.`
      )
    }

    const pageEditionIds: string[] = rawPageRows
      .map((r) => r.edition_id)
      .filter((id): id is string => !!id)

    if (pageEditionIds.length === 0) {
      console.log(
        `[FMV-RECALC] No editions found in window at offset ${offset} — durationMs=${Date.now() - startTime}`
      )
      // If the paginated sweep walked off the end, log a null cursor so the
      // next run wraps back to offset 0 instead of getting stuck on the empty
      // page past the end. (2026-06-10: now logs at offset 0 too — every exit
      // path must produce a pipeline_runs row or cron-silence alerts go blind.)
      {
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
            p_extra: { algo_version: ALGO_VERSION, sweep_wrapped: offset > 0, empty_window_at_zero: offset === 0 },
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
    let salesFetchErrors = 0
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
        // 2026-08-16: retried. This single fetch is what took the sweep dark for
        // 12.4 h — 14 of 17 consecutive runs logged `sales_refetch_failed: 1 chunk
        // fetch errors`, and ⚠ "1 chunk" is not one-of-many: IN_CHUNK equals
        // DEFAULT_LIMIT (both 500), so a full page is exactly ONE chunk and a
        // single transient pool timeout empties `salesPage`, skips the page, and
        // leaves the cursor pinned at its offset. Nothing downstream ran.
        // ⚠ A FACTORY, not a builder — a PostgREST builder is a single-use
        // thenable, so a retry closing over one object would re-await the first
        // attempt's settled result and "succeed" at retrying nothing.
        const { data: chunkSales, error: chunkErr } = await queryWithRetry<SaleRow[]>(
          () =>
            supabaseAdmin
              .from("sales")
              .select("edition_id, collection_id, price_usd, sold_at, serial_number")
              .gte("sold_at", windowStart)
              .gt("price_usd", 0)
              .neq("collection_id", PINNACLE_COLLECTION_ID)
              .in("edition_id", slice)
              .order("id", { ascending: true })
              .range(from, from + SALES_PAGE - 1),
          `fmv-recalc sales chunk ${i}+${from}`,
          { attempts: STEP1_RETRY_ATTEMPTS, baseDelayMs: STEP1_RETRY_BASE_MS, timeoutMs: STEP1B_BUDGET_MS }
        )
        if (chunkErr) {
          console.error(
            `[FMV-RECALC] Sales fetch error for edition slice ${i}-${i + slice.length} range ${from}:`,
            chunkErr.message
          )
          salesFetchErrors++
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
      // 2026-06-10: previously a SILENT unlogged exit. Under DB saturation every
      // Step-1b chunk fetch errors -> empty salesPage -> this path, which is how
      // fmv-recalc "went dark" 18:28-20:28Z while the cron showed green. Log it,
      // failing the run when the emptiness was caused by fetch errors.
      try {
        await supabaseAdmin.rpc("log_pipeline_run", {
          p_pipeline: "fmv-recalc",
          p_started_at: new Date(startTime).toISOString(),
          p_rows_found: pageEditionIds.length,
          p_rows_written: 0,
          p_rows_skipped: pageEditionIds.length,
          p_ok: salesFetchErrors === 0,
          p_error: salesFetchErrors > 0 ? `sales_refetch_failed: ${salesFetchErrors} chunk fetch errors (saturation-class)` : null,
          p_collection_slug: null,
          p_cursor_before: String(offset),
          p_cursor_after: String(offset),
          p_extra: { algo_version: ALGO_VERSION, stage: "step1b_refetch_empty", sales_fetch_errors: salesFetchErrors },
        })
      } catch (logErr) {
        console.warn("[FMV-RECALC] step1b-empty log failed:", logErr)
      }
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

    // ── Step 2a-quinquies: 90d catch-up seed (offset 0 only) ─────────────────
    // Editions that trade but NOT in the recent 30d window are never enumerated
    // by fmv_recalc_edition_page (a 30d GROUP BY), so they fall to ASK_ONLY /
    // NO_DATA / stale — or worse, keep a STALE false-HIGH — instead of a real
    // 90d sales-based MEDIUM. Seed each collection's set (>=5 sales/90d, 0/30d)
    // into editionSalesMap with EMPTY sales, so the existing 90d-widening
    // (Step 2a-quater) fetches their 90d sales and the main loop prices them off
    // the wider window. count30ByEdition captures 0 for them (seeded before that
    // capture), so gateHighToRecentVolume caps them at MEDIUM — HIGH stays
    // reserved for recent-30d liquidity (this is what re-prices the stale
    // false-HIGH tail). Purely additive: a seed that gets no 90d sales after the
    // mis-key filter stays empty and skips at the main-loop `sales.length === 0`
    // guard, keeping its prior snapshot. Offset-0 only (once per full sweep):
    // each enumeration is a ~12-17s 90d scan, far too heavy to run per page.
    // Non-fatal per collection. Measured 2026-08-07: 878 TS + 230 All Day in
    // scope (Golazos 2 / UFC 0 — not worth the extra scan). Pinnacle is excluded
    // (its FMV lives in pinnacle_fmv_history, not fmv_snapshots).
    if (offset === 0) {
      const CATCHUP_COLLECTIONS: [string, string][] = [
        ["Top Shot", TOPSHOT_COLLECTION_ID],
        ["All Day", ALLDAY_COLLECTION_ID],
      ]
      for (const [label, catchupCollectionId] of CATCHUP_COLLECTIONS) {
        try {
          const { data: catchupRows, error: catchupErr } = await (supabaseAdmin as any)
            .rpc("fmv_recalc_90d_catchup_editions", {
              p_collection_id: catchupCollectionId,
              p_limit: 2000,
            })
          if (catchupErr) {
            console.warn(`[FMV-RECALC] 90d catch-up enumeration error for ${label} (non-fatal):`, catchupErr.message)
            continue
          }
          let seeded = 0
          for (const row of (catchupRows as { edition_id: string }[] | null) ?? []) {
            const edId = String((row as any).edition_id)
            if (!edId || editionSalesMap.has(edId)) continue
            editionSalesMap.set(edId, {
              sales: [],
              collectionId: catchupCollectionId,
              latestSoldAt: new Date(0),
            })
            seeded++
          }
          if (seeded > 0) {
            console.log(`[FMV-RECALC] 90d catch-up: seeded ${seeded} zero-30d ${label} editions for 90d pricing`)
          }
        } catch (err) {
          console.warn(`[FMV-RECALC] 90d catch-up seed failed for ${label} (non-fatal):`, err instanceof Error ? err.message : err)
        }
      }
    }

    const editionIds = [...editionSalesMap.keys()]
    console.log(`[FMV-RECALC] Processing ${editionIds.length} distinct editions`)

    // ── Step 2a-bis: Fetch tier + circulation_count for the sanity guard ─────
    // Used downstream to skip anomalous high-priced single-sale snapshots on
    // common editions while preserving legitimate Legendary/Ultimate FMVs.
    // Chunked .in() to stay under PostgREST URL limits — at limit=2500 a single
    // .in() of UUIDs blows the request size and supabase-js returns an error.
    const editionMetaById = new Map<string, { tier: string | null; circulationCount: number | null; externalId: string | null; jersey: number | null }>()
    try {
      const META_CHUNK = 500
      for (let i = 0; i < editionIds.length; i += META_CHUNK) {
        const slice = editionIds.slice(i, i + META_CHUNK)
        const { data: edMetaRows, error: edMetaErr } = await supabaseAdmin
          .from("editions")
          .select("id, tier, circulation_count, external_id, jersey_number")
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
            jersey: (row as any).jersey_number == null ? null : Number((row as any).jersey_number),
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
    // ⚠ AGE, CARRIED ALONGSIDE THE ASK. Until 2026-08-29 the corroboration had NO age
    // bound, so an ask nobody had confirmed in 87 days could still lift an edition to
    // MEDIUM — and MEDIUM is what gates the public Below-FMV board. The threshold lives
    // in lib/fmv-confidence.ts (7 days, MEASURED — see the comment there for why it is
    // deliberately NOT the boards' 12 h display marker).
    const editionAskAgeHoursById = new Map<string, number | null>()
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
          .select("external_id, low_ask, updated_at")
          .in("external_id", slice)
          .gt("low_ask", 0)
        if (askErr) {
          console.warn(`[FMV-RECALC] ask fetch chunk ${i} error:`, askErr.message)
          continue
        }
        for (const row of askRows ?? []) {
          const ask = Number((row as any).low_ask)
          if (!(ask > 0)) continue
          // edition_offers.updated_at is NOT NULL in the schema, so null here means an
          // UNPARSEABLE value rather than a missing one — and it is passed through
          // rather than coalesced, because escalateConfidence treats "I could not date
          // this ask" as NOT corroborating. Substituting 0 would publish it as fresh.
          const rawAskAt = (row as any).updated_at
          const askAtMs = rawAskAt ? Date.parse(String(rawAskAt)) : NaN
          const askAgeHours = Number.isNaN(askAtMs) ? null : (Date.now() - askAtMs) / 3_600_000
          for (const edId of extIdToEditionIds.get(String((row as any).external_id)) ?? []) {
            editionAskById.set(edId, ask)
            editionAskAgeHoursById.set(edId, askAgeHours)
          }
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] ask fetch failed (non-fatal):", err instanceof Error ? err.message : err)
    }

    // ── Step 2a-ter(b): ceiling-ask map (TS edition_offers ∪ All Day floor) ───
    // The ask-ceiling (Step 1, capFmvAtCheapestAsk) must not let a sales-derived
    // base FMV exceed the cheapest current ask. Top Shot's ceiling source is the
    // edition_offers.low_ask feed built above; All Day's ask is NOT in
    // edition_offers (that carries All Day's bid side, highest_offer) — it lives
    // in allday_edition_floor_ask.floor_ask, keyed by edition_id. Build a
    // SEPARATE map for the ceiling so the All Day floor never leaks into
    // ask-corroboration (editionAskById stays Top-Shot-only by design): the
    // ceiling only ever LOWERS an overstated FMV, corroboration RAISES
    // confidence, so the two want different, independently-reasoned inputs.
    // Fetching by edition_id is inherently All-Day-scoped (only All Day editions
    // exist in that table). Measured 2026-08-08: 1,549 of 2,970 priced All Day
    // editions with a live floor read above it (avg 1.74x, max ~17x) — a
    // confident wrong number that fabricates "deals".
    const editionCeilingAskById = new Map<string, number>(editionAskById)
    try {
      const CEIL_CHUNK = 500
      for (let i = 0; i < editionIds.length; i += CEIL_CHUNK) {
        const slice = editionIds.slice(i, i + CEIL_CHUNK)
        const { data: adFloorRows, error: adFloorErr } = await supabaseAdmin
          .from("allday_edition_floor_ask")
          .select("edition_id, floor_ask")
          .in("edition_id", slice)
          .gt("floor_ask", 0)
        if (adFloorErr) {
          console.warn(`[FMV-RECALC] All Day floor-ask ceiling chunk ${i} error:`, adFloorErr.message)
          continue
        }
        for (const row of adFloorRows ?? []) {
          const ask = Number((row as any).floor_ask)
          if (!(ask > 0)) continue
          const edId = String((row as any).edition_id)
          // An edition is only ever one collection, so in practice this just
          // sets the All Day floor; min() is a belt-and-braces guard against an
          // edition_id colliding across both feeds.
          const prior = editionCeilingAskById.get(edId)
          editionCeilingAskById.set(edId, prior != null ? Math.min(prior, ask) : ask)
        }
      }
    } catch (err) {
      console.warn("[FMV-RECALC] All Day floor-ask ceiling fetch failed (non-fatal):", err instanceof Error ? err.message : err)
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
    // Capture the true 30-DAY sale count per edition BEFORE the 90d widening
    // below replaces `data.sales` with the wider set. HIGH confidence is
    // reserved for editions liquid in the RECENT 30d window (Trevor 2026-08-07:
    // "HIGH stays >=7 sales/30d"); the widened count may only earn MEDIUM.
    const count30ByEdition = new Map<string, number>()
    for (const [id, d] of editionSalesMap) count30ByEdition.set(id, d.sales.length)

    {
      const thinIds = [...editionSalesMap.entries()]
        .filter(([id, d]) => {
          if (d.sales.length < MIN_SALES_30D_MEDIUM) return true
          // Also widen when the TYPICAL-serial subset is too thin to set the
          // base, even if total volume is fine — the Traore "Metallic Gold LE"
          // class (5 sales/30d, only 2 non-premium serials). A 30d typical
          // median over 1-2 sales is unstable; 90d gives a robust typical
          // sample (Traore: 2 typical @30d -> 43 typical @90d, median $23).
          const meta = editionMetaById.get(id)
          let typN = 0
          for (const s of d.sales) {
            if (!isPremiumSerial(s.serial, meta?.circulationCount ?? null, meta?.jersey ?? null)) typN++
          }
          return typN < TYPICAL_SERIAL_MIN
        })
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
      let lastDeleteMessage: string | null = null
      let lastDelStatus: number | undefined
      let failedChunkOffset = -1
      for (let i = 0; i < editionIdsToWrite.length; i += DEL_CHUNK) {
        const slice = editionIdsToWrite.slice(i, i + DEL_CHUNK)
        // Retry a failed chunk once after a short pause — these failures are
        // overwhelmingly transient DB-saturation/statement-timeout, not a bad
        // query. One retry only; on hard failure the cursor stays put so the
        // same page is retried next tick anyway (mirrors rpcRetry/SMOKE-RETRY).
        let deleteError: { message: string } | null = null
        let delStatus: number | undefined
        for (let attempt = 0; attempt < 2; attempt++) {
          // 2026-07-13: moved off the inline PostgREST .delete() (which runs via
          // the authenticator, whose ~8s lock_timeout survives SET ROLE and made
          // this today-purge die "canceling statement due to lock timeout" under
          // evening contention) into a SECURITY DEFINER fn carrying
          // lock_timeout=25s, so a brief lock overlap waits it out. Same class as
          // the 07-11 upsert_pack_rips fix. Behavior-identical delete.
          const res = await supabaseAdmin.rpc("purge_fmv_snapshots_today", {
            p_edition_ids: slice,
            p_today_start: todayStart.toISOString(),
          })
          deleteError = res.error
          delStatus = res.status
          if (!deleteError) break
          if (attempt === 0) await new Promise((r) => setTimeout(r, 750))
        }
        if (deleteError) {
          console.error(
            `[FMV-RECALC] Step 3 delete chunk ${i}-${i + slice.length} failed:`,
            deleteError.message,
            { status: delStatus },
          )
          chunkFailed = true
          lastDeleteMessage = deleteError.message
          lastDelStatus = delStatus
          failedChunkOffset = i
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
            // Keep the constant as a prefix so existing pipeline_runs scans
            // still match, but carry the real PG error text for diagnosis.
            p_error: `step3_delete_chunk_failed: ${lastDeleteMessage ?? "unknown"}`,
            p_collection_slug: null,
            p_cursor_before: String(offset),
            p_cursor_after: String(offset),
            p_extra: {
              algo_version: ALGO_VERSION,
              stage: "step3_today_purge",
              failed_chunk_offset: failedChunkOffset,
              del_status: lastDelStatus ?? null,
            },
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

      // Serial-aware base (2026-06-20): the central VALUE is computed over typical
      // serials only — premium serials (#1 / perfect / jersey / low band) carry a
      // collector premium that belongs in the serial_fmv layer, not the edition
      // base, and was inflating FMV above the typical floor (fake deals). Fall
      // back to the full cleaned set when the typical subset is too thin to trust
      // (low-circ / grail-only editions) so no real edition loses pricing.
      // Confidence, volume and the serial-residual dispersion gate still use the
      // FULL set (prices/serials/sales.length) below.
      const circForSerial = edMeta?.circulationCount ?? null
      const jerseyForSerial = edMeta?.jersey ?? null
      const typicalSales = sales.filter(
        s => !isPremiumSerial(s.serial, circForSerial, jerseyForSerial),
      )
      const valueSales = typicalSales.length >= TYPICAL_SERIAL_MIN ? typicalSales : sales
      const valuePrices = valueSales.map(s => s.price)

      const median = trimmedMedian(valuePrices)
      const wap = weightedAveragePrice(valueSales, now)
      const floor = Math.min(...prices)
      // fmv_confidence is a Postgres enum with UPPERCASE values — never use lowercase strings here.
      const baseConfidence = computeConfidence(sales.length)
      // serials enable the serial-residual HIGH dispersion gate; the live ask
      // (when present) enables ask-corroboration LOW->MEDIUM (see lib/fmv-confidence.ts).
      let confidence: string = escalateConfidence(
        baseConfidence, sales.length, prices, serials,
        editionAskById.get(editionId) ?? null,
        // ⚠ `?? null` NOT `?? undefined`: an ask we hold but could not date must not
        // corroborate, and undefined is the legacy "caller is not age-aware" path.
        editionAskAgeHoursById.get(editionId) ?? null,
      )
      // Volume-tier gate (Trevor 2026-08-07): the 90d widening above lifts a
      // thin edition's effective count so it can price + earn MEDIUM off the
      // wider window — but HIGH is reserved for editions liquid in the RECENT
      // 30d window. Demote HIGH -> MEDIUM when the true 30d count is short of
      // the HIGH floor, so a stale-spread 90d edition never reads top-tier.
      confidence = gateHighToRecentVolume(confidence, count30ByEdition.get(editionId) ?? sales.length)
      const daysSinceSale = Math.round(
        (now.getTime() - latestSoldAt.getTime()) / (1000 * 60 * 60 * 24)
      )

      // Outlier-filtered WAP is the primary FMV signal — matches LiveToken's
      // averageWithoutWackos. Falls back to trimmed median when the cleaned
      // WAP collapses to 0 (e.g. tiny sales sets all rejected as outliers).
      // Computed over the typical-serial set (valueSales).
      const cleanWap = wapWithoutOutliers(valueSales, now)
      let fmv = cleanWap > 0 ? cleanWap : median
      // When the dampened set is too thin to trust the raw WAP, cap at 3x the
      // survivor median so a residual spike can't publish an absurd price.
      if (sales.length < 2 && capValue > 0) fmv = Math.min(fmv, capValue)

      // Ask-ceiling (Trevor 2026-08-07): the non-special-serial base FMV must
      // not exceed the cheapest current ask for this (sub)edition — a base FMV
      // above buy-it-now is a confident wrong number that fabricates "deals".
      // `fmv` here is computed over valueSales (premium/low serials excluded),
      // so it IS the non-special base; special-serial premiums are layered on by
      // the serial-multiplier pipeline downstream and stay exempt. Pure min():
      // only ever lowers an overstated value toward a real listing. Source is
      // editionCeilingAskById = Top Shot edition_offers.low_ask ∪ All Day
      // allday_edition_floor_ask.floor_ask (built at Step 2a-ter(b)).
      fmv = capFmvAtCheapestAsk(fmv, editionCeilingAskById.get(editionId) ?? null)

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
        asp_usd: Number(wap.toFixed(2)),
        asp_without_outliers: Number(cleanWap.toFixed(2)),
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
    // Null when the step ran; the error string when its candidate query failed.
    // Without this a count of 0 cannot be told apart from a step that never ran.
    let backfillError: string | null = null

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

      const { data: uncoveredEditions, error: uncoveredErr } = await supabaseAdmin
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

      // This read ignored `error` entirely until 2026-08-31 — supabase-js RETURNS
      // errors rather than throwing, so a failed candidate read resolved to
      // `{data: null, error}`, `?? []` turned it into an empty list, and the step
      // reported `backfill: 0` with not even a console.warn behind it.
      if (uncoveredErr) backfillError = uncoveredErr.message
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
          asp_usd: Number((row.low_ask * 0.90).toFixed(2)),
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
      backfillError = err instanceof Error ? err.message : String(err)
      console.warn("[FMV-RECALC] Backfill pass error:", backfillError)
    }

    // ── Step 5b: Historical sales fallback ───────────────────────────────────
    // Some editions have sales in sales_2026 but all older than the 30-day
    // recalc window. They never get a snapshot from Step 1 and they have no
    // badge_editions.low_ask (Step 5 backfill skips them). Compute a LOW
    // confidence FMV from whatever historical sales exist so these editions
    // show up in wallet valuations instead of silently reading as "no FMV".
    let historicalBackfillCount = 0
    // Non-null when the candidate query itself failed. Load-bearing for honesty:
    // without it a 100%-failing step and a step with nothing to do BOTH report
    // `historicalFallback=0`, which is exactly how this went unnoticed (see below).
    let historicalFallbackError: string | null = null

    // ⚠ REWRITTEN 2026-08-31 — this step had been failing on 100% of runs.
    // Every fmv-recalc tick in the whole pipeline_runs retention window (350 runs
    // over 4 days) logged "Historical fallback query error: canceling statement
    // due to statement timeout", and every one of them still reported
    // `historicalFallback=0`, `ok: true`, with `rows_written` looking healthy from
    // the OTHER steps. The failure was visible only in a console.warn nobody reads.
    // ⚠ The sizing first written here — "8,571 editions qualify, 4,277 with paid
    // sales getting no historical FMV at all" — was the OLD PREDICATE'S OUTPUT, not a
    // measure of genuine need, and it is retained only so the correction below reads
    // in order. The real backlog was ~13. Sizing a backlog with the same broken
    // predicate that defines it is circular; measure the PROPERTY instead.
    //
    // The old shape could not finish. `LIMIT 1000` sat AFTER the GROUP BY, so the
    // planner merge-joined ALL editions against 4,853,937 sales rows and aggregated
    // 25,595 groups before the limit could discard any of it — a textbook case of
    // "a LIMIT bounds a query's OUTPUT, not its COST".
    //
    // Now: pick the candidate editions FIRST (cheap per-edition LATERAL for the
    // latest snapshot, same predicate term-for-term), bound THAT to a small batch,
    // and only then join sales and aggregate.
    //   old shape        : TIMES OUT (>30s), 0 rows, every run
    //   candidate-first, LIMIT 1000 : 29,904 ms / 265,372 buffers — on the 30s wall
    //   candidate-first, LIMIT 200  :  6,981 ms /  75,418 buffers  ← shipped
    // Cutting ITEMS per tick rather than rows per item, per the standing rule.
    // At ~5 ticks/hour that is ~1,000 editions/hour, so the 4,277 backlog clears in
    // roughly 4 hours and then the step idles at whatever arrives.
    //
    // ✅ CONFIRMED IN PRODUCTION on the first tick after deploy (2026-09-01 05:15:47Z):
    // "Historical fallback complete: 200 editions covered", extra.historical_fallback
    // = 200 with historical_fallback_error = null, against 0 on each of the previous
    // 350 runs. The whole route also got FASTER — 42.1 s vs 53–100 s before — because
    // the step now completes instead of burning its budget into a timeout. If you are
    // reading this because the number is 0 again, read `historical_fallback_error`
    // first: it now tells you whether the step failed or simply had nothing to do.
    //
    // ⛔ CORRECTION 2026-09-01 ~00:1xZ — THE ADMISSION PREDICATE WAS WRONG, and making
    // the step RUN is what exposed it. 18 h after the fix: 119 runs, 23,800 editions
    // "covered", and the qualifying population had fallen only 4,277 → 3,382. It was
    // a TREADMILL, not a drain.
    //   The mechanism, read off one edition's snapshot history: this step writes
    //   `algo_version = 1.7.0` at 00:08:29, and the thin-sales guard overwrites the
    //   same edition with `algo_version = thin-sales-guard-v3` 43 seconds later. The
    //   old clause `algo_version NOT LIKE '1.7.%'` then re-admitted it on the very
    //   next tick, forever.
    //   `algo_version NOT LIKE '1.7.%'` was a staleness PROXY from when 1.7.x was the
    //   only writer. There are now EIGHT, and seven do not match: cold-tail-1.0 (2,537
    //   editions), thin-sales-guard-v3 (615), ask_only_v2 (86), topshot-gql-v1_haircut
    //   (82), allday-listing-ask-v1 (44), topshot-gql-v1 (13), ask_only_v2_haircut
    //   (12), thin-sales-guard-v3_p90clamp (1). None of them is stale — ZERO of the
    //   cold-tail rows were older than 7 days.
    //   Measured over the same population: old predicate admits 3,390, the staleness
    //   predicate admits 13 (10 NO_DATA + 3 older than 7 days + 0 never-priced).
    //   **99.6% of admissions were false**, ~200 redundant delete+insert pairs per tick
    //   on a hot partitioned table.
    // ⭐ So the test is now on the PROPERTY (computed_at age) rather than on the
    // IDENTITY of the writer. An algo-version allowlist would rot again the moment a
    // ninth writer appears; a staleness test cannot.
    // ⚠ Expect `historical_fallback` to read ~13 or 0 from here, NOT 200. That is the
    // step working correctly on a real backlog, not the old timeout — and
    // `historical_fallback_error` is what distinguishes the two.
    //
    // ⚠ The `EXISTS (sales)` is INSIDE the candidate CTE on purpose, and moving it
    // out would starve this backfill. 4,294 of the 8,571 qualifying editions have
    // NO paid sales and can never be converted by this step; if they could enter
    // the bounded candidate set they would occupy the head of an unordered LIMIT
    // forever and the same dead rows would be re-picked every tick while the
    // convertible ones were never reached. Editions that ARE converted stop
    // qualifying (the insert below always stamps algo_version = ALGO_VERSION and a
    // confidence of ASK_ONLY/SALES_ONLY/STALE/LOW — never NO_DATA), so the head
    // advances on its own.
    const HIST_CANDIDATE_LIMIT = 200

    try {
      const { data: histRows, error: histErr } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            WITH cand AS (
              SELECT e.id, e.collection_id, e.external_id, la.confidence::text AS prev_confidence
              FROM editions e
              LEFT JOIN LATERAL (
                SELECT fs.edition_id, fs.algo_version, fs.confidence, fs.computed_at
                FROM fmv_snapshots fs
                WHERE fs.edition_id = e.id
                ORDER BY fs.computed_at DESC
                LIMIT 1
              ) la ON true
              -- Admit editions with no snapshot, or a NO_DATA one, OR one that is
              -- genuinely STALE. Staleness is tested on computed_at, NOT on the
              -- algo_version string — see the correction below.
              -- Scoped to confidence='NO_DATA' ONLY — a broader relax would re-admit
              -- (and risk re-clobbering) good 1.7.x HIGH/MEDIUM rows, the 2026-05-30
              -- Step 6 self-perpetuating-cycle class.
              WHERE (la.edition_id IS NULL OR la.confidence = 'NO_DATA' OR la.computed_at < now() - interval '7 days')
                AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
                AND e.collection_id <> '${PINNACLE_COLLECTION_ID}'
                AND EXISTS (SELECT 1 FROM sales s WHERE s.edition_id = e.id AND s.price_usd > 0)
              LIMIT ${HIST_CANDIDATE_LIMIT}
            )
            SELECT
              c.id AS edition_id,
              c.collection_id,
              AVG(s.price_usd)::numeric AS avg_price,
              MIN(s.price_usd)::numeric AS min_price,
              COUNT(s.id) AS sales_count,
              MAX(s.sold_at) AS latest_sold_at,
              MAX(c.prev_confidence) AS prev_confidence,
              MAX(be.low_ask) FILTER (WHERE be.low_ask > 0 AND be.low_ask <= 10000) AS low_ask
            FROM cand c
            JOIN sales s ON s.edition_id = c.id
            LEFT JOIN badge_editions be ON be.external_id = c.external_id AND be.collection_id = c.collection_id
            WHERE s.price_usd > 0
            GROUP BY c.id, c.collection_id
          `,
        })

      if (histErr) {
        historicalFallbackError = histErr.message
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
                asp_usd: askFmv,
                asp_without_outliers: askFmv,
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
              asp_usd: Number(avgPrice.toFixed(2)),
              asp_without_outliers: Number(avgPrice.toFixed(2)),
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
      historicalFallbackError = err instanceof Error ? err.message : String(err)
      console.warn("[FMV-RECALC] Historical fallback error:", historicalFallbackError)
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
    //
    // ── LATEST-SNAPSHOT LOOKUP (Steps 5c / 5d / 5e), 2026-08-31 ──────────────
    // These three steps each used `WITH latest AS (SELECT DISTINCT ON (edition_id)
    // ... FROM fmv_snapshots ORDER BY edition_id, computed_at DESC)`, which walks
    // the WHOLE snapshot history (1,368,098 rows) to materialise 27,170, purely to
    // answer "does this edition have a snapshot, and is it NO_DATA?" for a handful
    // of candidates. Replaced with a per-edition LATERAL + LIMIT 1.
    // Measured warm-vs-warm on Step 5c (EXPLAIN ANALYZE BUFFERS, 2026-08-31):
    //   DISTINCT ON CTE : 98,172 buffers / 452 ms
    //   LATERAL LIMIT 1 : 75,975 buffers / 159 ms
    // Equivalence proven, NOT argued: over all 27,170 editions carrying a snapshot
    // (4,508 of them in the NO_DATA class this predicate selects on), the two forms
    // are EXCEPT-identical in both directions. The Step 5c EXCEPT alone would have
    // been VACUOUS — both forms return zero rows here — so the comparison was run
    // against the full edition population instead.
    //
    // ⛔ DO NOT "simplify" this to a read of public.edition_fmv_current. That swap
    // was the queued suggestion and it is NOT SAFE, measured 2026-08-31: the two
    // sources agree on membership (27,170 = 27,170, zero drift both ways) but
    // disagree on `confidence` for 41 editions, and for 4 of those
    // edition_fmv_current reads NO_DATA while the true latest snapshot does not.
    // Those 4 would be admitted here and have a real snapshot OVERWRITTEN with an
    // ASK_ONLY x0.90 haircut. This is the third time edition_fmv_current has been
    // found non-substitutable (see the 2026-08-24 and 2026-08-26 inbox filings).
    // The LATERAL reads fmv_snapshots directly, so it cannot drift at all.
    //
    // ⚠ Also falsified: hoisting the predicate into a COALESCE(...) = 'NO_DATA'
    // correlated subquery, to let the sales anti-join filter first. The planner
    // keeps it as a per-row SubPlan and it costs MORE (120,508 buffers). Measured,
    // not assumed — do not re-try it.
    let askOffersBackfillCount = 0
    // Null when the step ran; the error string when its candidate query failed.
    // Without this a count of 0 cannot be told apart from a step that never ran.
    let askOffersError: string | null = null
    try {
      const { data: askOnlyRows, error: askOnlyErr } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            SELECT e.id AS edition_id, e.collection_id, eo.low_ask
            FROM editions e
            JOIN edition_offers eo
              ON eo.external_id = e.external_id
             AND eo.collection_id = e.collection_id
            LEFT JOIN LATERAL (
              SELECT fs.edition_id, fs.confidence
              FROM fmv_snapshots fs
              WHERE fs.edition_id = e.id
              ORDER BY fs.computed_at DESC
              LIMIT 1
            ) l ON true
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
        askOffersError = askOnlyErr.message
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
              asp_usd: askFmv,
              asp_without_outliers: askFmv,
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
      askOffersError = err instanceof Error ? err.message : String(err)
      console.warn("[FMV-RECALC] edition_offers ASK fallback error:", askOffersError)
    }

    // ── Step 5e: Top Shot per-parallel ASK floor (STALE/NO_DATA :: editions) ──
    // The base-edition ASK feeds (badge_editions / edition_offers) are keyed on the
    // base setID:playID and carry NO per-parallel (::subID) rows, so a thinly traded
    // parallel whose sales went stale sits STALE/NO_DATA with no live floor — unlike
    // base editions, which Step 5/5b/5c float to ASK_ONLY. topshot_parallel_asks
    // (written by backfill-topshot-subedition-circulation from the same
    // searchMarketplaceEditions feed, keyed on the :: external_id) is the missing
    // per-parallel ask source. Mirror the TS ASK_ONLY pattern exactly: ASK_ONLY at
    // low_ask × 0.90 with the same <=$10k troll-ask ceiling. Scoped to :: editions
    // reading STALE / NO_DATA / no-snapshot — an edition with a fresh sales label
    // (HIGH/MEDIUM/LOW/SALES_ONLY) is strictly better and is never stolen.
    let parallelAskBackfillCount = 0
    // Null when the step ran; the error string when its candidate query failed.
    // Without this a count of 0 cannot be told apart from a step that never ran.
    let parallelAskError: string | null = null
    try {
      const { data: parAskRows, error: parAskErr } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            SELECT e.id AS edition_id, e.collection_id, ta.low_ask
            FROM editions e
            JOIN topshot_parallel_asks ta ON ta.external_id = e.external_id
            LEFT JOIN LATERAL (
              SELECT fs.edition_id, fs.confidence
              FROM fmv_snapshots fs
              WHERE fs.edition_id = e.id
                AND fs.collection_id = '${TOPSHOT_COLLECTION_ID}'
              ORDER BY fs.computed_at DESC
              LIMIT 1
            ) l ON true
            WHERE e.collection_id = '${TOPSHOT_COLLECTION_ID}'
              AND e.external_id ~ '::'
              AND (l.edition_id IS NULL OR l.confidence IN ('STALE','NO_DATA'))
              AND ta.low_ask > 0
              AND ta.low_ask <= 10000
              AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
            LIMIT 2000
          `,
        })

      if (parAskErr) {
        parallelAskError = parAskErr.message
        console.warn("[FMV-RECALC] parallel ASK floor query error:", parAskErr.message)
      } else {
        const rows = (parAskRows as { edition_id: string; collection_id: string; low_ask: number | string }[] | null) ?? []
        if (rows.length > 0) {
          console.log(`[FMV-RECALC] parallel ASK floor: ${rows.length} STALE/NO_DATA :: editions with a live ask`)

          const parRows = rows.map((row) => {
            const ask = Number(row.low_ask)
            const askFmv = Number((ask * 0.90).toFixed(2))
            return applyAllFmvGuards({
              edition_id: row.edition_id,
              collection_id: row.collection_id,
              fmv_usd: askFmv,
              floor_price_usd: Number(ask.toFixed(2)),
              asp_usd: askFmv,
              asp_without_outliers: askFmv,
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
          const parEditionIds = parRows.map((r) => r.edition_id)
          const DEL_CHUNK = 500
          for (let i = 0; i < parEditionIds.length; i += DEL_CHUNK) {
            const slice = parEditionIds.slice(i, i + DEL_CHUNK)
            const { error: parDelErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .delete()
              .in("edition_id", slice)
              .gte("computed_at", todayStart.toISOString())
            if (parDelErr) console.warn("[FMV-RECALC] parallel ASK floor delete error:", parDelErr.message)
          }

          for (let i = 0; i < parRows.length; i += CHUNK_SIZE) {
            const chunk = parRows.slice(i, i + CHUNK_SIZE)
            const { error: parInsErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .insert(chunk)
            if (!parInsErr) parallelAskBackfillCount += chunk.length
            else console.warn("[FMV-RECALC] parallel ASK floor insert error:", parInsErr.message)
          }

          console.log(`[FMV-RECALC] parallel ASK floor complete: ${parallelAskBackfillCount} :: editions floored`)
        }
      }
    } catch (err) {
      parallelAskError = err instanceof Error ? err.message : String(err)
      console.warn("[FMV-RECALC] parallel ASK floor error:", parallelAskError)
    }

    // ── Step 5d: All Day floor-ask ASK fallback (zero-sales NO_DATA tail) ─────
    // LiveToken does NOT cover All Day, so the TS ASK_ONLY structure (Step 5/5b/5c)
    // is replicated here using the All Day-native ask source instead. All Day's
    // ask is NOT in badge_editions.low_ask (null platform-wide) nor edition_offers
    // (which only carries the bid side, highest_offer); it lives in
    // allday_edition_floor_ask.floor_ask (the cheapest active on-chain listing,
    // keyed by edition_id). ~606 All Day editions sit NO_DATA with a live floor —
    // zero sales (so Step 5b's `JOIN sales` never admits them) + an existing
    // NO_DATA snapshot (so Step 5's no-snapshot guard skips them). Price them
    // ASK_ONLY at floor × 0.90, the same haircut + ≤$10k troll-ask ceiling the TS
    // path uses, so they read as honest floor-anchored value instead of "no FMV".
    // Zero-sales-only: any All Day edition with a sale heals to a sales label via
    // Step 5b (strictly better), so we never steal it here. ASK_ONLY is exempt
    // from both stale guards, so there is no re-clobber churn.
    let allDayAskBackfillCount = 0
    // Null when the step ran; the error string when its candidate query failed.
    // Without this a count of 0 cannot be told apart from a step that never ran.
    let allDayAskError: string | null = null
    try {
      const { data: adAskRows, error: adAskErr } = await supabaseAdmin
        .rpc("query_sql", {
          query: `
            SELECT e.id AS edition_id, e.collection_id, af.floor_ask
            FROM editions e
            JOIN allday_edition_floor_ask af ON af.edition_id = e.id
            LEFT JOIN LATERAL (
              SELECT fs.edition_id, fs.confidence
              FROM fmv_snapshots fs
              WHERE fs.edition_id = e.id
              ORDER BY fs.computed_at DESC
              LIMIT 1
            ) l ON true
            WHERE (l.edition_id IS NULL OR l.confidence = 'NO_DATA')
              AND af.floor_ask > 0
              AND af.floor_ask <= 10000
              AND (e.tier IS NULL OR e.tier <> 'ULTIMATE')
              AND e.collection_id = '${ALLDAY_COLLECTION_ID}'
              AND NOT EXISTS (
                SELECT 1 FROM sales s
                WHERE s.edition_id = e.id AND s.price_usd > 0
              )
            LIMIT 1000
          `,
        })

      if (adAskErr) {
        allDayAskError = adAskErr.message
        console.warn("[FMV-RECALC] All Day ASK fallback query error:", adAskErr.message)
      } else {
        const rows = (adAskRows as { edition_id: string; collection_id: string; floor_ask: number | string }[] | null) ?? []
        if (rows.length > 0) {
          console.log(`[FMV-RECALC] All Day ASK fallback: ${rows.length} zero-sales NO_DATA editions with a live floor`)

          const adRows = rows.map((row) => {
            const ask = Number(row.floor_ask)
            const askFmv = Number((ask * 0.90).toFixed(2))
            return applyAllFmvGuards({
              edition_id: row.edition_id,
              collection_id: row.collection_id,
              fmv_usd: askFmv,
              floor_price_usd: Number(ask.toFixed(2)),
              asp_usd: askFmv,
              asp_without_outliers: askFmv,
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
          const adEditionIds = adRows.map((r) => r.edition_id)
          const DEL_CHUNK = 500
          for (let i = 0; i < adEditionIds.length; i += DEL_CHUNK) {
            const slice = adEditionIds.slice(i, i + DEL_CHUNK)
            const { error: adDelErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .delete()
              .in("edition_id", slice)
              .gte("computed_at", todayStart.toISOString())
            if (adDelErr) console.warn("[FMV-RECALC] All Day ASK fallback delete error:", adDelErr.message)
          }

          for (let i = 0; i < adRows.length; i += CHUNK_SIZE) {
            const chunk = adRows.slice(i, i + CHUNK_SIZE)
            const { error: adInsErr } = await supabaseAdmin
              .from("fmv_snapshots")
              .insert(chunk)
            if (!adInsErr) allDayAskBackfillCount += chunk.length
            else console.warn("[FMV-RECALC] All Day ASK fallback insert error:", adInsErr.message)
          }

          console.log(`[FMV-RECALC] All Day ASK fallback complete: ${allDayAskBackfillCount} editions covered`)
        }
      }
    } catch (err) {
      allDayAskError = err instanceof Error ? err.message : String(err)
      console.warn("[FMV-RECALC] All Day ASK fallback error:", allDayAskError)
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
    // Null when the step ran; the error string when its candidate query failed.
    // Without this a count of 0 cannot be told apart from a step that never ran.
    let staleTouchError: string | null = null
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
                  fs.asp_usd,
                  fs.asp_without_outliers,
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
                l.asp_usd,
                l.asp_without_outliers,
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
          staleTouchError = staleErr.message
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
              asp_usd: r.asp_usd,
              asp_without_outliers: r.asp_without_outliers,
              liquidity_rating: r.liquidity_rating,
              // Volume-tier gate (Trevor 2026-08-07: "HIGH stays >=7 sales/30d").
              // Every row here matched `rt.edition_id IS NULL` — i.e. ZERO sales
              // in the recent 30d window — so a preserved HIGH is a fossil: the
              // edition was hot when last priced, went cold, and this liveness
              // re-stamp carried its HIGH forward unchanged, bypassing the gate
              // the main-loop write applies. Pass 0 (the true recent count for a
              // re-stamped edition) so HIGH demotes to MEDIUM; MEDIUM/others pass
              // through untouched. Display-neutral (the confidence enum never
              // renders; see lib/fmv-basis.ts) — this only stops a cold edition
              // from counting as HIGH in the confidence-share metric.
              confidence: gateHighToRecentVolume(String(r.confidence), 0),
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
        staleTouchError = err instanceof Error ? err.message : String(err)
        console.warn("[FMV-RECALC] Stale touch error:", staleTouchError)
      }
    }

    // ── Step 8: Thin-sale haircut on freshly-recalc'd collections ────────────
    // fmv_apply_thin_sale_haircut filters internally to LOW + ASK_ONLY, so
    // HIGH/MEDIUM rows we just wrote are untouched. Calling it inline here
    // means newly-computed ASK-only FMVs get haircut on the same run instead
    // of drifting back to floor between recalcs. Scope to the collection set
    // we actually saw sales for; if the batch was empty (early-return path
    // wouldn't reach here), fall back to NULL = all collections.
    // 2026-08-30: SCOPED TO THE EDITIONS THIS RUN WROTE. The per-collection call
    // did a DISTINCT ON over EVERY snapshot of the collection (twice) to touch the
    // ~130 rows just written — 38 s / 2.6M buffers per collection, every ~10 min,
    // the #1 DB consumer in a quiet-hour window (ledger 2026-08-29, saturation).
    // fmv_apply_thin_sale_haircut_for_editions applies the identical rules to an
    // explicit id list (a few k buffers). The daily full-scope job
    // (/api/admin/apply-fmv-haircut, 15:35 PT) keeps the catch-all semantics, so
    // an empty page now does nothing here instead of a NULL = all-collections pass.
    let haircutRowsTotal = 0
    let haircutCollectionsRun = 0
    try {
      const haircutEditionIds = [...editionSalesMap.keys()]
      if (haircutEditionIds.length > 0) {
        const { data: hc, error: hcErr } = await supabaseAdmin.rpc(
          "fmv_apply_thin_sale_haircut_for_editions",
          { p_edition_ids: haircutEditionIds, p_dry_run: false }
        )
        if (hcErr) {
          console.warn(
            `[FMV-RECALC] Haircut RPC error (editions=${haircutEditionIds.length}): ${hcErr.message}`
          )
        } else {
          const row = Array.isArray(hc) && hc.length > 0 ? hc[0] : null
          const haircut = Number(row?.rows_haircut ?? 0)
          haircutRowsTotal += haircut
          haircutCollectionsRun += 1
          console.log(
            `[FMV-RECALC] Haircut applied editions=${haircutEditionIds.length} examined=${row?.rows_examined ?? 0} haircut=${haircut} dollars_removed=${row?.dollars_removed ?? 0}`
          )
        }
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

    // ── Step 10: Disconnected-ASK / bimodal p90 clamp ────────────────────────
    // fmv_clamp_disconnected_ask clamps LOW/ASK_ONLY FMVs that are disconnected
    // from actual trading — fmv > 3x median AND > 1.5x p90 of the edition's
    // >$0.10 90d sales — down to GREATEST(p90x1.5, median). This is the bimodal
    // fake-deal class (e.g. Derrick White 218:8204 fmv $23.80 vs a $0.29 median /
    // $0.95 p90, 92 sales) that the max-sale display guard cannot catch, because
    // these FMVs sit BELOW the edition's own max sale (the max IS the stale
    // outlier that inflated the WAP). Run INLINE here — after EVERY snapshot
    // write this run, including the Step 8 haircut — so a freshly repriced
    // edition is born clamped instead of headlining a fake -98% deal on the
    // Market/Sniper boards for ~23h until the daily rpc-fmv-clamp-disconnected
    // -ask cron catches up (the cron fires at 08:55Z, BEFORE the big recalc
    // sweep, so it was always a day behind). LOW/ASK_ONLY only — HIGH/MEDIUM
    // confident pricing and genuine wide editions (p90x1.5 headroom) are never
    // touched. Non-fatal — a clamp error never fails the recalc run.
    //
    // SCOPED PER COLLECTION, exactly like the Step 8 haircut above. Until
    // 2026-08-04 this was gated on `sawTopShot` AND called a function that
    // hardcoded the Top Shot UUID in both its CTEs, so All Day was never clamped
    // at all — two COMMON base moments (circ 10,000) were publishing $24.75 and
    // $14.30 against $0.37 / $0.25 real order books. Fixing only the SQL would
    // not have been enough: the `sawTopShot` gate would still have skipped any
    // page that wrote no Top Shot editions.
    //
    // Scoping rather than one NULL = all-collections call is deliberate. Measured
    // live 2026-08-03: one collection is 4.0s / 823k buffers, full scope is 15.7s
    // / 1,240k buffers — and this route already averages 181s against a 300s wall
    // with ~23.6% of invocations killed there, so a blanket +11.7s inline would
    // buy All Day's correctness by pushing more runs over the wall. The daily
    // pg_cron backstop is the one that runs full scope. When the page wrote
    // nothing we skip entirely rather than falling back to NULL: there is no
    // freshly-written row to be born clamped, so a full-scope scan would be pure
    // cost. Pinnacle short-circuits to zero inside the function (its FMV is
    // render-keyed in pinnacle_fmv_history, not fmv_snapshots).
    //
    // 2026-08-30: SCOPED TO THE EDITIONS THIS RUN WROTE (same reason as Step 8).
    // The per-collection call ran a 90-day sales aggregate over every edition of
    // the collection plus a DISTINCT ON over all its snapshots — 56 s / 1.3M
    // buffers per collection every ~10 min, and it timed out outright on All Day
    // under load. fmv_clamp_disconnected_ask_for_editions applies the identical
    // rules to the explicit id list and skips Pinnacle editions inside; the daily
    // pg_cron backstop (jobid 69) still runs the full scope.
    let clampRows = 0
    try {
      const clampEditionIds: string[] = []
      for (const [editionId, { collectionId }] of editionSalesMap.entries()) {
        if (collectionId && collectionId !== PINNACLE_COLLECTION_ID) {
          clampEditionIds.push(editionId)
        }
      }
      if (clampEditionIds.length > 0) {
        const { data: clampRes, error: clampErr } = await supabaseAdmin.rpc(
          "fmv_clamp_disconnected_ask_for_editions",
          { p_edition_ids: clampEditionIds, p_dry_run: false },
        )
        if (clampErr) {
          console.warn(
            `[FMV-RECALC] disconnected-ask clamp error (editions=${clampEditionIds.length}, non-fatal): ${clampErr.message}`,
          )
        } else {
          const row = Array.isArray(clampRes) && clampRes.length > 0 ? clampRes[0] : null
          const clamped = Number(row?.rows_clamped ?? 0)
          clampRows += clamped
          if (clamped > 0) {
            console.log(
              `[FMV-RECALC] disconnected-ask clamp: editions=${clampEditionIds.length} rows_clamped=${clamped} dollars_removed=${row?.dollars_removed ?? 0}`,
            )
          }
        }
      }
    } catch (err) {
      console.warn(
        "[FMV-RECALC] disconnected-ask clamp threw (non-fatal):",
        err instanceof Error ? err.message : err,
      )
    }

    // hasMore is keyed on the distinct-edition page size — never the sales
    // count — since pagination unit is distinct editions.
    // `>=` not `===`: an exact-equality check silently reads false whenever the
    // page is truncated below the requested limit, which is precisely how the
    // 2026-08-03 stall hid (PostgREST returned 1000 against a limit of 2500).
    // With limit < the row cap this is equivalent, but it can no longer fail
    // silently in that direction.
    const hasMore = pageEditionIds.length >= limit
    const duration = Date.now() - startTime

    console.log(
      `[FMV-RECALC] Done — editions=${editionIds.length} snapshots=${snapshotsUpdated} blended=${blendedCount} askProxy=${askProxyCount} washTradeFiltered=${washTradeEditionCount} backfill=${backfillCount} historicalFallback=${historicalBackfillCount}${historicalFallbackError ? ` historicalFallbackFAILED="${historicalFallbackError}"` : ""} askOffersFallback=${askOffersBackfillCount} allDayAskFallback=${allDayAskBackfillCount} staleTouch=${staleTouchCount} haircut=${haircutRowsTotal} thinSalesCaps=${thinSalesCaps?.total_caps_applied ?? 0} disconnectedAskClamp=${clampRows} hasMore=${hasMore} duration=${duration}ms`
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
          // 2026-08-03: extra recorded haircut/wash-trade/clamp counts but NOT
          // the pagination state, so a sweep that never advanced looked healthy
          // for 20 hours. These three are the ones that would have shown it.
          page_size: pageEditionIds.length,
          edition_limit: limit,
          has_more: hasMore,
          blended: blendedCount,
          ask_proxy: askProxyCount,
          wash_trade_filtered: washTradeEditionCount,
          // ⚠ EVERY per-step count below is paired with an `*_error` key, and the
          // pairing is the point. A count of 0 on its own is ambiguous — nothing
          // to do, or the step never ran — and that ambiguity hid a 100%-failing
          // historical fallback for at least 350 consecutive runs (2026-08-31):
          // `ok` was true, `rows_written` was healthy from the other steps, and
          // the only trace was a console.warn nobody reads. Same class as the
          // 2026-08-03 pagination-state gap noted above. Null = the step ran.
          // ⛔ Do NOT add a new step count here without its `_error` sibling.
          backfill: backfillCount,
          backfill_error: backfillError,
          historical_fallback: historicalBackfillCount,
          historical_fallback_error: historicalFallbackError,
          ask_offers_fallback: askOffersBackfillCount,
          ask_offers_fallback_error: askOffersError,
          // parallel_ask_floor had NO count key at all until 2026-08-31 — the step
          // floors :: editions in production (3 on the 04:48Z run) and reported
          // nothing at all to pipeline_runs.
          parallel_ask_floor: parallelAskBackfillCount,
          parallel_ask_floor_error: parallelAskError,
          allday_ask_fallback: allDayAskBackfillCount,
          allday_ask_fallback_error: allDayAskError,
          stale_touch: staleTouchCount,
          stale_touch_error: staleTouchError,
          haircut_rows: haircutRowsTotal,
          haircut_collections_run: haircutCollectionsRun,
          thin_sales_caps: thinSalesCaps,
          disconnected_ask_clamp_rows: clampRows,
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
          // ⚠ NULL, not 0 (corrected 2026-08-29). This path is a THROW at an
          // unknown point in the run, so the counters are not zero — they are
          // UNKNOWN, and work may already have been written before it. A hard 0
          // here is the `?? 0` fabrication in telemetry: a number nobody took,
          // reading as a measured zero. Every other 0 in this file is on a path
          // that genuinely counted none, which is why only this one moved.
          // `log_pipeline_run` stopped COALESCEing an explicit NULL to 0 in
          // migration 20260829040000, so the NULL now survives the round trip.
          p_rows_found: null,
          p_rows_written: null,
          p_rows_skipped: null,
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
    // No heartbeat finalize: kills are detected by the NOT-EXISTS correlation
    // documented at the marker insert above (a finally is unreliable here, and a
    // normal run's terminal fmv-recalc row at the same started_at already proves
    // completion). The 'started' marker is left as-is.
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