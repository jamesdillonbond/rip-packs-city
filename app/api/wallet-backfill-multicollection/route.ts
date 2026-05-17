// app/api/wallet-backfill-multicollection/route.ts
//
// Orchestrator that fans out to every per-collection enrichment route.
// Used by the allow-list approval / new-wallet onboarding flow and by
// seed-wallet-refresh's 6-hour cron sweep.
//
// Per-collection coverage (May 10, 2026):
//   - nba_top_shot   → /api/wallet-backfill            (fire-and-forget)
//   - nfl_all_day    → /api/wallet-backfill-allday     (SYNC-MODE)
//   - disney_pinnacle → /api/wallet-backfill-pinnacle  (SYNC-MODE)
//   - laliga_golazos → /api/wallet-backfill-golazos    (fire-and-forget)
//   - ufc_strike     → /api/wallet-backfill-ufc        (fire-and-forget)
//
// Pool-saturation context (Round 7 fix):
//   Pre-fix: every child returned 202 immediately and ran an after()
//   background worker for 100-600s. With seed-wallet-refresh's 8-way
//   concurrency × 5 children × 200 wallets, the post-burst sustained
//   ~40 background workers competing for the 60-conn Supabase pool,
//   starving the unrelated crons that fire at HH:05 (pinnacle-resolver,
//   sync-flowty-listings, wmc-fmv-populate).
//
//   Post-fix: AllDay + Pinnacle (the two longest-tailed children) run
//   in sync mode. The orchestrator polls each one sequentially per
//   wallet inside its own after() task with bounded round-trip budgets.
//   No background after() leaks past the multicollection lambda — the
//   sync children either complete or return a next_checkpoint we loop
//   on. Combined with the Round 6 8-way concurrency cap on the seed
//   refresher, peak pool pressure is bounded to ~24 lambdas
//   (8 wallets × 3 fire-and-forget children) plus 8 in-flight sync
//   children (one per parallel wallet).

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const dynamic = "force-dynamic"
// 800s ceiling gives ~180s of headroom over the worst-case
// 2 round-trips × (270s child budget + 30s slack) + transient-retry
// backoff budget (~18s across both round-trips). See syncPoll() below
// for the transient-retry behavior.
export const maxDuration = 800

const SYNC_MAX_DURATION_MS = 270_000
// Per-collection round-trip cap. Default=2. nfl_all_day is consistently
// the worst offender in pipeline_runs (2026-05-17 audit: 923 runs in
// last 24h, dispatch gaps overwhelmingly on nfl_all_day with HTTP 500
// from child or AbortSignal timeout). Extended to 4 so 5xx transient
// failures during HH:00 fan-out have more headroom to recover before
// being recorded as a hard dispatch_error.
const SYNC_ROUND_TRIP_CAP_DEFAULT = 2
const SYNC_ROUND_TRIP_CAP_BY_COLLECTION: Record<string, number> = {
  nfl_all_day: 4,
}
const SYNC_ROUND_TRIP_CAP_MAX = 4
function capFor(slug: string): number {
  return SYNC_ROUND_TRIP_CAP_BY_COLLECTION[slug] ?? SYNC_ROUND_TRIP_CAP_DEFAULT
}

interface SyncTarget {
  slug: string
  path: string
}
interface FireOnceTarget {
  slug: string
  path: string
}

const SYNC_COLLECTIONS: SyncTarget[] = [
  { slug: "nfl_all_day",     path: "/api/wallet-backfill-allday" },
  { slug: "disney_pinnacle", path: "/api/wallet-backfill-pinnacle" },
]
const FIRE_AND_FORGET_COLLECTIONS: FireOnceTarget[] = [
  { slug: "nba_top_shot",   path: "/api/wallet-backfill" },
  { slug: "laliga_golazos", path: "/api/wallet-backfill-golazos" },
  { slug: "ufc_strike",     path: "/api/wallet-backfill-ufc" },
]

interface FireOnceResult {
  collection: string
  status: number
  ok: boolean
  body?: unknown
  error?: string
}

interface SyncResult {
  collection: string
  ok: boolean
  round_trips: number
  final_complete: boolean
  rows_processed_total: number
  last_checkpoint: string | null
  last_status: number | null
  errors: string[]
  transient_retries: number
  recovered_after_retry: boolean
  round_trip_cap: number
}

// Round 12 Item 1: retry+backoff wrapper for log_pipeline_run.
// supabase-js does NOT throw on RPC errors — it returns {data, error}. Round 11
// telemetry showed avg dispatch-row write taking 39.5s with ~50% silently
// dropped when 240 wallets land in the orchestrator within a 5-second window
// from seed-wallet-refresh. Cause: Supabase PostgREST/pool contention during
// the burst. Fix: destructure {error}, retry on transient failure with
// exponential backoff. Three attempts at 100ms / 500ms / 2000ms.
async function logPipelineRunWithRetry(
  pipeline: string,
  args: Record<string, unknown>,
  context: string,
): Promise<boolean> {
  const delaysMs = [100, 500, 2000]
  let lastErr: string | null = null
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (attempt > 0) {
      await new Promise<void>(resolve => setTimeout(resolve, delaysMs[attempt - 1]))
    }
    try {
      const { error } = await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: pipeline,
        ...args,
      })
      if (!error) return true
      lastErr = `${error.code ?? "?"}: ${error.message ?? String(error)}`
      console.warn(
        `[wallet-backfill-multicollection] ${context} attempt=${attempt} rpc_error=${lastErr}`,
      )
    } catch (thrown) {
      lastErr = thrown instanceof Error ? thrown.message : String(thrown)
      console.warn(
        `[wallet-backfill-multicollection] ${context} attempt=${attempt} threw=${lastErr}`,
      )
    }
  }
  console.warn(
    `[wallet-backfill-multicollection] ${context} GAVE UP after ${delaysMs.length + 1} attempts last=${lastErr}`,
  )
  return false
}

async function fireOnce(
  origin: string,
  target: FireOnceTarget,
  wallet: string,
  skipCached: boolean,
  ingestToken: string,
): Promise<FireOnceResult> {
  try {
    const res = await fetch(`${origin}${target.path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ingestToken}`,
      },
      body: JSON.stringify({ wallet, skip_cached: skipCached }),
      signal: AbortSignal.timeout(10_000),
    })
    let body: unknown = null
    try { body = await res.json() } catch { /* ignore */ }
    return {
      collection: target.slug,
      status: res.status,
      ok: res.status === 202 || res.ok,
      body,
    }
  } catch (err) {
    return {
      collection: target.slug,
      status: 0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// Sync-poll loop. Each invocation passes the current checkpoint (or none
// on the first round-trip) and waits for the child to either complete or
// hit its caller-supplied wall-clock budget. ok=true requires the final
// round-trip's body.complete=true.
//
// Transient-retry behavior: HTTP 5xx, missing status, parse-failed body,
// or network/timeout exceptions are treated as transient (most often
// lambda-concurrency-exhaustion HTTP 503 during HH:00 fan-out). They
// push an error sample, sleep 1500ms × (rt+1) of backoff, and continue
// the next iteration WITHOUT advancing checkpoint — the child is
// idempotent and re-resumes from whatever it last committed. Only 4xx
// status codes break the loop (real client/auth bugs that won't resolve
// by retrying).
async function syncPoll(
  origin: string,
  target: SyncTarget,
  wallet: string,
  skipCached: boolean,
  ingestToken: string,
): Promise<SyncResult> {
  const cap = capFor(target.slug)
  const result: SyncResult = {
    collection: target.slug,
    ok: false,
    round_trips: 0,
    final_complete: false,
    rows_processed_total: 0,
    last_checkpoint: null,
    last_status: null,
    errors: [],
    transient_retries: 0,
    recovered_after_retry: false,
    round_trip_cap: cap,
  }
  let checkpoint: string | null = null
  let priorRtWasTransient = false

  for (let rt = 0; rt < cap; rt++) {
    result.round_trips = rt + 1
    const qs = new URLSearchParams({
      sync: "true",
      max_duration_ms: String(SYNC_MAX_DURATION_MS),
    })
    if (checkpoint !== null) qs.set("checkpoint", checkpoint)
    const url = `${origin}${target.path}?${qs.toString()}`

    type SyncChildResponse = {
      ok?: boolean
      complete?: boolean
      next_checkpoint?: string | null
      rows_processed?: number
      error?: string
    }
    let isTransient = false
    let parsedBody: SyncChildResponse | null = null

    try {
      // Per-round-trip timeout = sync budget + 30s slack for post-pass +
      // log_pipeline_run. Children write their own pipeline_runs row, so
      // a timeout here means the lambda was killed before logging — the
      // dropped event will surface as a missing pipeline_runs row at
      // the next health check.
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestToken}`,
        },
        body: JSON.stringify({ wallet, skip_cached: skipCached }),
        signal: AbortSignal.timeout(SYNC_MAX_DURATION_MS + 30_000),
      })
      result.last_status = res.status
      parsedBody = await res.json().catch(() => null) as SyncChildResponse | null

      if (parsedBody === null) {
        result.errors.push(`rt=${rt} HTTP ${res.status} body=(parse failed) — transient, retrying`)
        isTransient = true
      } else if (!res.ok) {
        const status = res.status
        if (status >= 500 && status < 600) {
          result.errors.push(`rt=${rt} HTTP ${status} body=${parsedBody.error ?? "(no body)"} — transient (5xx), retrying`)
          isTransient = true
        } else {
          // 4xx — real client/auth bug. Retrying won't help.
          result.errors.push(`rt=${rt} HTTP ${status} body=${parsedBody.error ?? "(no body)"}`)
          break
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`rt=${rt} ${msg} — network/timeout transient, retrying`)
      isTransient = true
    }

    if (isTransient) {
      result.transient_retries++
      priorRtWasTransient = true
      // 3000ms × 2^rt: 3s, 6s, 12s, 24s. Bigger headroom than the
      // pre-2026-05-17 1500ms × (rt+1) (3s, 4.5s) — fewer retries get
      // burned to a still-saturated lambda pool. Capped by maxDuration
      // (800s) and the per-round-trip 270s+30s budget.
      const backoffMs = 3000 * Math.pow(2, rt)
      console.warn(
        `[wallet-backfill-multicollection] sync transient wallet=${wallet} collection=${target.slug} rt=${rt} cap=${cap} backoff_ms=${backoffMs}`
      )
      await new Promise<void>(resolve => setTimeout(resolve, backoffMs))
      continue
    }

    const body = parsedBody!
    if (typeof body.rows_processed === "number") result.rows_processed_total += body.rows_processed

    if (body.complete === true) {
      result.ok = body.ok !== false
      result.final_complete = true
      result.last_checkpoint = null
      if (priorRtWasTransient) {
        result.recovered_after_retry = true
        console.warn(
          `[wallet-backfill-multicollection] sync recovered_after_retry wallet=${wallet} collection=${target.slug} transient_retries=${result.transient_retries} final_rt=${result.round_trips}`
        )
      }
      return result
    }

    // Not complete — re-loop with the returned checkpoint. Reject if the
    // child returned complete=false but no checkpoint (treat as fatal).
    if (body.next_checkpoint == null) {
      result.errors.push(`rt=${rt} complete=false but next_checkpoint=null — aborting loop`)
      break
    }
    checkpoint = body.next_checkpoint
    result.last_checkpoint = checkpoint
  }

  if (!result.final_complete && result.errors.length === 0) {
    result.errors.push(`hit SYNC_ROUND_TRIP_CAP=${cap} (${target.slug}) without complete=true`)
  }
  return result
}

export async function POST(req: NextRequest) {
  const authHeader = req.headers.get("authorization")
  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken || authHeader !== `Bearer ${ingestToken}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  let body: { wallet?: string; skip_cached?: boolean }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const wallet = body.wallet?.trim()
  if (!wallet) {
    return NextResponse.json({ error: "wallet field required" }, { status: 400 })
  }
  const skipCached = body.skip_cached !== false
  const origin = new URL(req.url).origin

  // Telemetry shape (Round 12 Item 1 — replaces Round 11 layout):
  //   DISPATCH row (pipeline='wallet-backfill-multicollection-dispatch') is the
  //   first thing after() does, BEFORE fire-and-forget so no compute path can
  //   silently drop it. It's a "started" marker. dispatched_per_collection is
  //   all-zeros at this point — the actual per-collection success/failure
  //   lands on the COMPLETE row. Pairing key: extra->>'wallet_address'.
  //
  //   COMPLETE row (pipeline='wallet-backfill-multicollection-complete') is
  //   written at the END of after() with the full sync picture (fire_ms,
  //   sync_round_trips_actual, sync_completed_collections). dispatch row with
  //   no matching complete row within ~15min = killed lambda — that's the
  //   visibility we want.
  //
  //   Both writes go through logPipelineRunWithRetry which destructures
  //   {error} from supabase-js (silently dropped by the prior bare-await
  //   pattern) and retries 3x with backoff for transient PostgREST contention.
  //   Round 11 telemetry verification at 18:00 UTC May 11 found 121 final
  //   rows with no matching dispatch row, all caused by silent RPC error
  //   drops during the 240-wallet 5-second burst.
  const startedAtIso = new Date().toISOString()
  after(async () => {
    const t0 = Date.now()

    // ---- DISPATCH telemetry row ----
    // Top of after(). All collections marked 0 = pending; the COMPLETE row
    // carries actual fire-and-forget + sync outcomes.
    const initialDispatched: Record<string, number> = {}
    for (const target of FIRE_AND_FORGET_COLLECTIONS) initialDispatched[target.slug] = 0
    for (const target of SYNC_COLLECTIONS) initialDispatched[target.slug] = 0
    await logPipelineRunWithRetry(
      "wallet-backfill-multicollection-dispatch",
      {
        p_started_at: startedAtIso,
        p_rows_found: 1,
        p_rows_written: 0,
        p_rows_skipped: 0,
        p_ok: true,
        p_error: null,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          wallet_address: wallet,
          wallets_targeted: 1,
          phase: "dispatch",
          dispatched_per_collection: initialDispatched,
          fire_and_forget_collections: FIRE_AND_FORGET_COLLECTIONS.map(t => t.slug),
          sync_collections_pending: SYNC_COLLECTIONS.map(t => t.slug),
          sync_round_trip_cap_default: SYNC_ROUND_TRIP_CAP_DEFAULT,
          sync_round_trip_cap_max: SYNC_ROUND_TRIP_CAP_MAX,
          sync_round_trip_cap_by_collection: SYNC_ROUND_TRIP_CAP_BY_COLLECTION,
        },
      },
      `dispatch wallet=${wallet}`,
    )

    // ---- Phase 1: fire-and-forget dispatch (parallel) ----
    const fireResults = await Promise.all(
      FIRE_AND_FORGET_COLLECTIONS.map(t => fireOnce(origin, t, wallet, skipCached, ingestToken))
    )
    const fireMs = Date.now() - t0

    const dispatched: Record<string, number> = {}
    const dispatchErrors: Record<string, number> = {}
    const dispatchErrorSamples: Record<string, string[]> = {}

    for (const r of fireResults) {
      dispatched[r.collection] = r.ok ? 1 : 0
      if (!r.ok) {
        dispatchErrors[r.collection] = 1
        dispatchErrorSamples[r.collection] = [r.error ?? `HTTP ${r.status}`]
      }
    }
    for (const target of SYNC_COLLECTIONS) {
      dispatched[target.slug] = 0
    }

    // ---- Phase 2: sync-poll loop ----
    const syncResults = await Promise.all(SYNC_COLLECTIONS.map(target => syncPoll(origin, target, wallet, skipCached, ingestToken)))
    const totalMs = Date.now() - t0

    console.log(
      `[wallet-backfill-multicollection] wallet=${wallet} ` +
      `fire_ok=${fireResults.filter(r => r.ok).length}/${fireResults.length} fire_ms=${fireMs} ` +
      `sync_ok=${syncResults.filter(r => r.ok).length}/${syncResults.length} ` +
      `sync_round_trips=${syncResults.map(r => `${r.collection}:${r.round_trips}`).join(",")} ` +
      `total_ms=${totalMs}`
    )
    for (const r of syncResults) {
      if (!r.ok) {
        console.warn(
          `[wallet-backfill-multicollection] sync child failed wallet=${wallet} collection=${r.collection} ` +
          `errors=${r.errors.join("|")}`
        )
      }
    }

    // Merge sync outcomes into the dispatched/errors maps for the END row.
    for (const r of syncResults) {
      dispatched[r.collection] = r.final_complete ? 1 : 0
      if (r.errors.length > 0) {
        dispatchErrors[r.collection] = r.errors.length
        dispatchErrorSamples[r.collection] = r.errors.slice(0, 3)
      }
    }
    const allDispatched =
      Object.keys(dispatched).length === FIRE_AND_FORGET_COLLECTIONS.length + SYNC_COLLECTIONS.length &&
      Object.values(dispatched).every(v => v > 0)

    const syncRoundTripsActual = syncResults.map(r => ({
      collection: r.collection,
      round_trips: r.round_trips,
      ok: r.ok,
      final_complete: r.final_complete,
      transient_retries: r.transient_retries,
      recovered_after_retry: r.recovered_after_retry,
      round_trip_cap: r.round_trip_cap,
    }))
    const syncCompletedCollections = syncResults.filter(r => r.final_complete).map(r => r.collection)
    const recoveredAfterRetryCount = syncResults.filter(r => r.recovered_after_retry).length
    const transientRetriesTotal = syncResults.reduce((a, r) => a + r.transient_retries, 0)

    // ---- COMPLETE telemetry row ----
    // Distinct pipeline name so dispatch/complete pair cleanly at query time.
    await logPipelineRunWithRetry(
      "wallet-backfill-multicollection-complete",
      {
        p_started_at: startedAtIso,
        p_rows_found: 1,
        p_rows_written: Object.values(dispatched).reduce((a, b) => a + b, 0),
        p_rows_skipped: Object.values(dispatchErrors).reduce((a, b) => a + b, 0),
        p_ok: allDispatched,
        p_error: allDispatched ? null : `dispatch gaps: ${Object.entries(dispatched).filter(([, v]) => v === 0).map(([k]) => k).join(",") || "none"}`,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          wallet_address: wallet,
          wallets_targeted: 1,
          phase: "complete",
          dispatched_per_collection: dispatched,
          dispatch_errors_per_collection: dispatchErrors,
          dispatch_error_samples: dispatchErrorSamples,
          fire_ms: fireMs,
          total_ms: totalMs,
          sync_round_trips_actual: syncRoundTripsActual,
          sync_completed_collections: syncCompletedCollections,
          recovered_after_retry: recoveredAfterRetryCount,
          transient_retries_total: transientRetriesTotal,
        },
      },
      `complete wallet=${wallet}`,
    )
  })

  return NextResponse.json(
    {
      wallet_address: wallet,
      skip_cached: skipCached,
      accepted_count: FIRE_AND_FORGET_COLLECTIONS.length + SYNC_COLLECTIONS.length,
      collection_count: FIRE_AND_FORGET_COLLECTIONS.length + SYNC_COLLECTIONS.length,
      sync_collections: SYNC_COLLECTIONS.map(t => t.slug),
      fire_and_forget_collections: FIRE_AND_FORGET_COLLECTIONS.map(t => t.slug),
    },
    { status: 202 }
  )
}
