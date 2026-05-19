// snapshot-institutional-wallets
//
// Daily snapshot of every signal_source wallet's holdings. Runs once a
// day at 06:00 UTC via cron-job.org. Captures (wallet, collection,
// moment_ids[], moment_count, total_fmv_usd) into wallet_holdings_snapshot,
// then immediately calls compute_institutional_wallet_diff for every
// (wallet, collection) pair to detect new arrivals since yesterday.
//
// Wallet selection criteria:
//   * tags @> ARRAY['signal_source']
//   * fully_enriched_at IS NOT NULL
//
// Resilience contract (function_version 2, 2026-05-17):
//   * Heartbeat to public.cron_heartbeats as the first action in
//     runWork, so even an immediate panic still proves the function
//     started. The Vercel route also heartbeats — both rows mean
//     cron-job.org fired AND the edge function spun up.
//   * Every Supabase call (RPC + table read + upsert) is wrapped in
//     withRetry: 3 attempts, 1500 * 2^rt + 250ms jitter.
//   * wallet_moments_cache reads are paginated in PAGE_SIZE chunks
//     via .range(). The pre-2026-05-17 single-shot read was being
//     silently clipped at 1000 rows by PostgREST's default cap (that
//     is why prior runs showed moments_snapshotted=1000 even for
//     wallets with >>1000 holdings).
//   * On retry exhaustion of any wrapped op, a pipeline_runs row is
//     written immediately with ok=false tagging the failed op, IN
//     ADDITION to the final aggregate row. That preserves "one
//     row per overall run" for legacy callers while surfacing the
//     specific failure boundary for the watchlist.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 2
const PIPELINE = "snapshot-institutional-wallets"
const COLLECTION_SLUG = "nba_top_shot"
const PAGE_SIZE = 250
const RETRY_MAX = 3
const RETRY_BASE_MS = 1500
const RETRY_JITTER_MS = 250

interface SignalWallet {
  username: string | null
  wallet_address: string
}

interface MomentRow {
  collection_id: string
  moment_id: string
  fmv_usd: number | null
}

interface SnapshotRow {
  wallet_address: string
  collection_id: string
  snapshot_at: string
  moment_ids: string[]
  moment_count: number
  total_fmv_usd: number
}

function isTransientErr(msg: string): boolean {
  const m = msg.toLowerCase()
  return (
    m.includes("timeout") ||
    m.includes("timed out") ||
    m.includes("connection pool") ||
    m.includes("upstream request") ||
    m.includes("network") ||
    m.includes("temporarily") ||
    m.includes("503") ||
    m.includes("502") ||
    m.includes("504") ||
    m.includes("429")
  )
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function withRetry<T>(
  label: string,
  op: () => Promise<{ data: T | null; error: { message: string } | null }>,
): Promise<{ data: T | null; error: string | null; attempts: number }> {
  let lastErr: string | null = null
  for (let attempt = 0; attempt < RETRY_MAX; attempt++) {
    try {
      const { data, error } = await op()
      if (!error) {
        return { data, error: null, attempts: attempt + 1 }
      }
      lastErr = error.message
      if (!isTransientErr(error.message)) {
        // Non-transient — fail fast.
        return { data: null, error: error.message, attempts: attempt + 1 }
      }
      console.log(`[${PIPELINE}] ${label} attempt ${attempt + 1} transient: ${error.message}`)
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err)
      console.log(`[${PIPELINE}] ${label} attempt ${attempt + 1} threw: ${lastErr}`)
    }
    if (attempt < RETRY_MAX - 1) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * RETRY_JITTER_MS)
      await sleep(delay)
    }
  }
  return { data: null, error: lastErr ?? "unknown", attempts: RETRY_MAX }
}

async function logExhaustionRun(args: {
  startedAt: string
  label: string
  err: string
  attempts: number
  walletHint?: string
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: 0,
      p_rows_written: 0,
      p_rows_skipped: 0,
      p_ok: false,
      p_error: `${args.label} exhausted retries: ${args.err}`,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        function_version: FUNCTION_VERSION,
        partial: true,
        op_label: args.label,
        op_attempts: args.attempts,
        wallet_hint: args.walletHint ?? null,
      },
    })
  } catch (err) {
    console.log(`[${PIPELINE}] logExhaustionRun failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function emitHeartbeat(source: string): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    const { error } = await (supabase as any).rpc("upsert_cron_heartbeat", {
      p_pipeline: PIPELINE,
      p_source: source,
    })
    if (error) {
      console.log(`[${PIPELINE}] heartbeat err: ${error.message}`)
    }
  } catch (err) {
    console.log(`[${PIPELINE}] heartbeat threw: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function loadSignalWallets(startedAtIso: string): Promise<SignalWallet[]> {
  const res = await withRetry<SignalWallet[]>("loadSignalWallets", async () => {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabase as any)
      .from("seeded_wallets")
      .select("username, wallet_address")
      .contains("tags", ["signal_source"])
      .not("fully_enriched_at", "is", null)
      .not("wallet_address", "is", null)
    return { data: data as SignalWallet[] | null, error }
  })
  if (res.error) {
    await logExhaustionRun({
      startedAt: startedAtIso,
      label: "loadSignalWallets",
      err: res.error,
      attempts: res.attempts,
    })
    return []
  }
  return res.data ?? []
}

async function loadAllMomentsForWallet(wallet: string, startedAtIso: string): Promise<{ rows: MomentRow[]; err?: string }> {
  const all: MomentRow[] = []
  let from = 0
  // Defensive ceiling — 500 pages * 250 = 125k moments per wallet.
  // Raised 2026-05-19 from 200 (50k) because NBATopShotCommunity at
  // 51,352 moments was getting truncated and the run logged ok=false
  // every day. The ceiling exists to bound pathological input — if
  // ANY wallet ever needs >125k moments captured in one snapshot,
  // that's almost certainly a data bug worth investigating, and the
  // run will correctly log ok=false with the truncated_at_125000 err.
  const MAX_PAGES = 500
  for (let page = 0; page < MAX_PAGES; page++) {
    const to = from + PAGE_SIZE - 1
    const res = await withRetry<MomentRow[]>(`wmc.range(${wallet.slice(0, 8)},${from})`, async () => {
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabase as any)
        .from("wallet_moments_cache")
        .select("collection_id, moment_id, fmv_usd")
        .eq("wallet_address", wallet)
        .range(from, to)
      return { data: data as MomentRow[] | null, error }
    })
    if (res.error) {
      await logExhaustionRun({
        startedAt: startedAtIso,
        label: `wmc_load_page_${page}`,
        err: res.error,
        attempts: res.attempts,
        walletHint: wallet,
      })
      return { rows: all, err: `wmc load page ${page}: ${res.error}` }
    }
    const batch = res.data ?? []
    all.push(...batch)
    if (batch.length < PAGE_SIZE) {
      return { rows: all }
    }
    from += PAGE_SIZE
  }
  return { rows: all, err: `truncated_at_${MAX_PAGES * PAGE_SIZE}` }
}

async function captureSnapshot(
  wallet: string,
  todayUtc: string,
  startedAtIso: string,
): Promise<{ collections_captured: number; total_moments: number; pages_walked: number; errors: string[] }> {
  const load = await loadAllMomentsForWallet(wallet, startedAtIso)
  const rows = load.rows
  const errors: string[] = []
  if (load.err) errors.push(`load: ${load.err}`)
  if (rows.length === 0) {
    return { collections_captured: 0, total_moments: 0, pages_walked: 0, errors }
  }

  const pagesWalked = Math.ceil(rows.length / PAGE_SIZE)

  const byCollection = new Map<string, { ids: string[]; total_fmv: number }>()
  for (const r of rows) {
    const bucket = byCollection.get(r.collection_id) ?? { ids: [], total_fmv: 0 }
    bucket.ids.push(String(r.moment_id))
    bucket.total_fmv += r.fmv_usd != null ? Number(r.fmv_usd) : 0
    byCollection.set(r.collection_id, bucket)
  }

  // One snapshot row per collection. Upsert sequentially with retry so
  // a transient pool-exhaustion on one collection's huge moment_ids
  // array does not cancel the whole wallet.
  let written = 0
  for (const [collection_id, { ids, total_fmv }] of byCollection.entries()) {
    ids.sort()
    const row: SnapshotRow = {
      wallet_address: wallet,
      collection_id,
      snapshot_at: todayUtc,
      moment_ids: ids,
      moment_count: ids.length,
      total_fmv_usd: Math.round(total_fmv * 100) / 100,
    }
    const res = await withRetry<unknown>(`whs.upsert(${collection_id.slice(0, 8)})`, async () => {
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabase as any)
        .from("wallet_holdings_snapshot")
        .upsert([row], { onConflict: "wallet_address,collection_id,snapshot_at" })
      return { data, error }
    })
    if (res.error) {
      errors.push(`upsert(${collection_id.slice(0, 8)}, ${ids.length}ids): ${res.error}`)
      await logExhaustionRun({
        startedAt: startedAtIso,
        label: `whs_upsert_${collection_id.slice(0, 8)}`,
        err: res.error,
        attempts: res.attempts,
        walletHint: wallet,
      })
      continue
    }
    written++
  }

  return { collections_captured: written, total_moments: rows.length, pages_walked: pagesWalked, errors }
}

async function diffAllPairs(
  wallet: string,
  startedAtIso: string,
): Promise<{ inserted_buybacks: number; pairs_diffed: number; errors: string[] }> {
  const todayUtc = (new Date()).toISOString().slice(0, 10)
  const res = await withRetry<Array<{ collection_id: string }>>("whs.pairs_load", async () => {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabase as any)
      .from("wallet_holdings_snapshot")
      .select("collection_id")
      .eq("wallet_address", wallet)
      .eq("snapshot_at", todayUtc)
    return { data: data as Array<{ collection_id: string }> | null, error }
  })
  if (res.error) {
    await logExhaustionRun({
      startedAt: startedAtIso,
      label: "whs_pairs_load",
      err: res.error,
      attempts: res.attempts,
      walletHint: wallet,
    })
    return { inserted_buybacks: 0, pairs_diffed: 0, errors: [`pairs_load: ${res.error}`] }
  }

  let totalInserted = 0
  const errors: string[] = []
  let pairsDiffed = 0

  for (const row of (res.data ?? [])) {
    pairsDiffed++
    const diffRes = await withRetry<{ inserted?: number } | null>(`diff(${row.collection_id.slice(0, 8)})`, async () => {
      // deno-lint-ignore no-explicit-any
      const { data, error } = await (supabase as any).rpc(
        "compute_institutional_wallet_diff",
        { p_wallet: wallet, p_collection_id: row.collection_id }
      )
      return { data: data as { inserted?: number } | null, error }
    })
    if (diffRes.error) {
      errors.push(`diff(${row.collection_id.slice(0, 8)}): ${diffRes.error}`)
      await logExhaustionRun({
        startedAt: startedAtIso,
        label: `diff_${row.collection_id.slice(0, 8)}`,
        err: diffRes.error,
        attempts: diffRes.attempts,
        walletHint: wallet,
      })
      continue
    }
    const inserted = Number(diffRes.data?.inserted ?? 0)
    if (Number.isFinite(inserted)) totalInserted += inserted
  }

  return { inserted_buybacks: totalInserted, pairs_diffed: pairsDiffed, errors }
}

async function logRun(args: {
  startedAt: string
  rowsFound: number
  rowsWritten: number
  rowsSkipped: number
  ok: boolean
  error?: string | null
  extra: Record<string, unknown>
}) {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: args.startedAt,
      p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten,
      p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok,
      p_error: args.error ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
  } catch (err) {
    console.log(`[${PIPELINE}] log_pipeline_run failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

async function runWork(startedAtIso: string, started: number) {
  await emitHeartbeat("edge_runwork_start")

  // Step 1: opportunistically promote any signal_source wallets that
  // have crossed the enrichment threshold so they enter tomorrow's pool.
  const promoteRes = await withRetry<unknown[]>("mark_signal_wallets_fully_enriched", async () => {
    // deno-lint-ignore no-explicit-any
    const { data, error } = await (supabase as any).rpc("mark_signal_wallets_fully_enriched")
    return { data: data as unknown[] | null, error }
  })
  if (promoteRes.error) {
    await logExhaustionRun({
      startedAt: startedAtIso,
      label: "mark_signal_wallets_fully_enriched",
      err: promoteRes.error,
      attempts: promoteRes.attempts,
    })
  }
  const promotedCount = Array.isArray(promoteRes.data) ? promoteRes.data.length : 0

  // Step 2: load the snapshot pool (wallets that ARE fully enriched).
  const wallets = await loadSignalWallets(startedAtIso)
  if (wallets.length === 0) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: true,
      extra: {
        function_version: FUNCTION_VERSION,
        message: "no_fully_enriched_signal_wallets",
        wallets_promoted_to_fully_enriched: promotedCount,
        elapsed_ms: Date.now() - started,
      },
    })
    return
  }

  const todayUtc = (new Date()).toISOString().slice(0, 10)

  let totalCollectionsSnapshotted = 0
  let totalMomentsSnapshotted = 0
  let totalBuybacksInserted = 0
  let totalPairsDiffed = 0
  let totalPagesWalked = 0
  const errors: string[] = []

  for (const w of wallets) {
    const snap = await captureSnapshot(w.wallet_address, todayUtc, startedAtIso)
    totalCollectionsSnapshotted += snap.collections_captured
    totalMomentsSnapshotted += snap.total_moments
    totalPagesWalked += snap.pages_walked
    if (snap.errors.length > 0) errors.push(`${w.username}: ${snap.errors.join("; ")}`)

    if (snap.collections_captured > 0) {
      const diff = await diffAllPairs(w.wallet_address, startedAtIso)
      totalBuybacksInserted += diff.inserted_buybacks
      totalPairsDiffed += diff.pairs_diffed
      if (diff.errors.length > 0) errors.push(`${w.username}: ${diff.errors.join("; ")}`)
    }
  }

  await logRun({
    startedAt: startedAtIso,
    rowsFound: wallets.length,
    rowsWritten: totalCollectionsSnapshotted,
    rowsSkipped: 0,
    ok: errors.length === 0,
    error: errors.length > 0 ? `errors: ${errors[0]}` : null,
    extra: {
      function_version: FUNCTION_VERSION,
      snapshot_date: todayUtc,
      wallets_processed: wallets.length,
      wallets_promoted_to_fully_enriched: promotedCount,
      collections_snapshotted: totalCollectionsSnapshotted,
      moments_snapshotted: totalMomentsSnapshotted,
      pages_walked: totalPagesWalked,
      page_size: PAGE_SIZE,
      pairs_diffed: totalPairsDiffed,
      buybacks_inserted: totalBuybacksInserted,
      error_count: errors.length,
      sample_errors: errors.slice(0, 5),
      elapsed_ms: Date.now() - started,
    },
  })
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) {
    return new Response("Unauthorized", { status: 401 })
  }

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runWork(startedAtIso, started).catch((e) => {
    const msg = e instanceof Error ? e.message : String(e)
    console.log(`[${PIPELINE}] runWork uncaught: ${msg}`)
    // Best-effort: surface uncaught panics as a pipeline_runs row so
    // they aren't completely invisible.
    return logRun({
      startedAt: startedAtIso,
      rowsFound: 0,
      rowsWritten: 0,
      rowsSkipped: 0,
      ok: false,
      error: `runWork uncaught: ${msg}`,
      extra: { function_version: FUNCTION_VERSION, panicked: true, elapsed_ms: Date.now() - started },
    })
  })
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      function_version: FUNCTION_VERSION,
      note: "Real results will appear in pipeline_runs within ~10-30s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
