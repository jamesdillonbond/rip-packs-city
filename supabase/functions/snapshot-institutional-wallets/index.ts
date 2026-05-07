// snapshot-institutional-wallets
//
// Daily snapshot of every signal_source wallet's holdings. Runs once a
// day at 06:00 UTC via cron-job.org. Captures (wallet, collection,
// moment_ids[], moment_count, total_fmv_usd) into wallet_holdings_snapshot,
// then immediately calls compute_institutional_wallet_diff for every
// (wallet, collection) pair to detect new arrivals since yesterday.
//
// Wallet selection criteria (per Prompt 12 amended):
//   * tags @> ARRAY['signal_source']
//   * fully_enriched_at IS NOT NULL  (avoid mid-enrichment days
//     producing a flood of fake "arrivals")
//
// Two NBATopShotCommunity / NBATopShot_Holdings / TopShot_Buyback_2
// wallets currently meet criterion 1; criterion 2 fires once their
// initial enrichment crosses the 95%-of-expected threshold (the
// mark_signal_wallets_fully_enriched RPC checks this).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var required")

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? ""
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? ""
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const FUNCTION_VERSION = 1
const PIPELINE = "snapshot-institutional-wallets"
const COLLECTION_SLUG = "nba_top_shot"

interface SignalWallet {
  username: string | null
  wallet_address: string
}

async function loadSignalWallets(): Promise<SignalWallet[]> {
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabase as any)
    .from("seeded_wallets")
    .select("username, wallet_address")
    .contains("tags", ["signal_source"])
    .not("fully_enriched_at", "is", null)
    .not("wallet_address", "is", null)

  if (error) {
    console.log(`[${PIPELINE}] loadSignalWallets err: ${error.message}`)
    return []
  }
  return (data ?? []) as SignalWallet[]
}

interface SnapshotRow {
  wallet_address: string
  collection_id: string
  snapshot_at: string
  moment_ids: string[]
  moment_count: number
  total_fmv_usd: number
}

async function captureSnapshot(wallet: string, todayUtc: string): Promise<{ collections_captured: number; total_moments: number; errors: string[] }> {
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabase as any)
    .from("wallet_moments_cache")
    .select("collection_id, moment_id, fmv_usd")
    .eq("wallet_address", wallet)

  if (error) {
    return { collections_captured: 0, total_moments: 0, errors: [`load: ${error.message}`] }
  }

  const rows = (data ?? []) as Array<{ collection_id: string; moment_id: string; fmv_usd: number | null }>
  if (rows.length === 0) {
    return { collections_captured: 0, total_moments: 0, errors: [] }
  }

  // Group by collection_id; for each, collect moment_ids (sorted for
  // deterministic snapshot equality) + count + total_fmv.
  const byCollection = new Map<string, { ids: string[]; total_fmv: number }>()
  for (const r of rows) {
    const bucket = byCollection.get(r.collection_id) ?? { ids: [], total_fmv: 0 }
    bucket.ids.push(String(r.moment_id))
    bucket.total_fmv += r.fmv_usd != null ? Number(r.fmv_usd) : 0
    byCollection.set(r.collection_id, bucket)
  }

  const snapshotRows: SnapshotRow[] = []
  for (const [collection_id, { ids, total_fmv }] of byCollection.entries()) {
    ids.sort()
    snapshotRows.push({
      wallet_address: wallet,
      collection_id,
      snapshot_at: todayUtc,
      moment_ids: ids,
      moment_count: ids.length,
      total_fmv_usd: Math.round(total_fmv * 100) / 100,
    })
  }

  const { error: upsertErr } = await (supabase as any)
    .from("wallet_holdings_snapshot")
    .upsert(snapshotRows, { onConflict: "wallet_address,collection_id,snapshot_at" })

  if (upsertErr) {
    return { collections_captured: 0, total_moments: rows.length, errors: [`upsert: ${upsertErr.message}`] }
  }

  return { collections_captured: snapshotRows.length, total_moments: rows.length, errors: [] }
}

async function diffAllPairs(wallet: string): Promise<{ inserted_buybacks: number; pairs_diffed: number; errors: string[] }> {
  // Pull today's snapshot rows for this wallet so we know which
  // (wallet, collection) pairs to diff. Same source-of-truth as the
  // snapshot we just wrote, so the loop covers exactly the data that
  // was just captured.
  const todayUtc = (new Date()).toISOString().slice(0, 10)
  // deno-lint-ignore no-explicit-any
  const { data, error } = await (supabase as any)
    .from("wallet_holdings_snapshot")
    .select("collection_id")
    .eq("wallet_address", wallet)
    .eq("snapshot_at", todayUtc)

  if (error) {
    return { inserted_buybacks: 0, pairs_diffed: 0, errors: [`pairs_load: ${error.message}`] }
  }

  let totalInserted = 0
  const errors: string[] = []
  let pairsDiffed = 0

  for (const row of (data ?? []) as Array<{ collection_id: string }>) {
    pairsDiffed++
    // deno-lint-ignore no-explicit-any
    const { data: diffResult, error: diffErr } = await (supabase as any).rpc(
      "compute_institutional_wallet_diff",
      { p_wallet: wallet, p_collection_id: row.collection_id }
    )
    if (diffErr) {
      errors.push(`diff(${row.collection_id.slice(0, 8)}): ${diffErr.message}`)
      continue
    }
    const inserted = Number(diffResult?.inserted ?? 0)
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
  // Step 1: opportunistically promote any signal_source wallets that
  // have crossed the 95%-of-expected enrichment threshold so they enter
  // tomorrow's snapshot pool.
  // deno-lint-ignore no-explicit-any
  const { data: promoted } = await (supabase as any).rpc(
    "mark_signal_wallets_fully_enriched"
  )
  const promotedCount = Array.isArray(promoted) ? promoted.length : 0

  // Step 2: load the snapshot pool (wallets that ARE fully enriched).
  const wallets = await loadSignalWallets()
  if (wallets.length === 0) {
    await logRun({
      startedAt: startedAtIso,
      rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
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
  const errors: string[] = []

  for (const w of wallets) {
    const snap = await captureSnapshot(w.wallet_address, todayUtc)
    totalCollectionsSnapshotted += snap.collections_captured
    totalMomentsSnapshotted += snap.total_moments
    if (snap.errors.length > 0) errors.push(`${w.username}: ${snap.errors.join("; ")}`)

    if (snap.collections_captured > 0) {
      const diff = await diffAllPairs(w.wallet_address)
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
  const workPromise = runWork(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch(e => console.log(`[${PIPELINE}] waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`))
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
