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
// Bumped from 30s to 600s — the orchestrator now blocks on sync-mode
// AllDay + Pinnacle children inside its own after() task. Each child
// round-trip is bounded at SYNC_MAX_DURATION_MS so the worst case is
// (ceil(on_chain_count / chunk_size) / chunks_per_round) round-trips
// per wallet × 270s each. Mega-wallet pinnacle (~7700 NFTs at 500/chunk
// = 16 chunks, ~8s/chunk = ~130s) finishes in a single round-trip.
export const maxDuration = 600

const SYNC_MAX_DURATION_MS = 270_000
// Round 11 Item 1: cut from 6 → 2.
// Round 10 telemetry showed max sync-phase wall-clock of ~580s on AllDay pathological
// wallets, hitting the 600s lambda cap and killing the final log_pipeline_run write.
// With 2 round-trips × 270s per-trip ceiling = ~540s worst case before the post-loop
// telemetry row, leaving ~60s of slack inside the 600s lambda budget. Wallets that
// need more progression simply continue at the next 6h tick.
const SYNC_ROUND_TRIP_CAP = 2 // safety: max retries per (wallet, sync collection)

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
async function syncPoll(
  origin: string,
  target: SyncTarget,
  wallet: string,
  skipCached: boolean,
  ingestToken: string,
): Promise<SyncResult> {
  const result: SyncResult = {
    collection: target.slug,
    ok: false,
    round_trips: 0,
    final_complete: false,
    rows_processed_total: 0,
    last_checkpoint: null,
    last_status: null,
    errors: [],
  }
  let checkpoint: string | null = null

  for (let rt = 0; rt < SYNC_ROUND_TRIP_CAP; rt++) {
    result.round_trips = rt + 1
    const qs = new URLSearchParams({
      sync: "true",
      max_duration_ms: String(SYNC_MAX_DURATION_MS),
    })
    if (checkpoint !== null) qs.set("checkpoint", checkpoint)
    const url = `${origin}${target.path}?${qs.toString()}`

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
      const body = await res.json().catch(() => null) as {
        ok?: boolean
        complete?: boolean
        next_checkpoint?: string | null
        rows_processed?: number
        error?: string
      } | null

      if (!res.ok || body === null) {
        result.errors.push(`rt=${rt} HTTP ${res.status} body=${body?.error ?? "(no body)"}`)
        break
      }

      if (typeof body.rows_processed === "number") result.rows_processed_total += body.rows_processed

      if (body.complete === true) {
        result.ok = body.ok !== false
        result.final_complete = true
        result.last_checkpoint = null
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
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push(`rt=${rt} ${msg}`)
      break
    }
  }

  if (!result.final_complete && result.errors.length === 0) {
    result.errors.push(`hit SYNC_ROUND_TRIP_CAP=${SYNC_ROUND_TRIP_CAP} without complete=true`)
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

  // Fire-and-forget side fires in parallel; sync side awaits sequentially
  // (per-wallet) inside the same after() task so the multicollection
  // lambda holds the wallet's sync round-trips while the other three
  // children's after() workers run independently in their own lambdas.
  //
  // Telemetry shape (Round 11 Item 1 — replaces Round 9 single-row layout):
  // split into START + END rows.
  //   START row (pipeline='wallet-backfill-multicollection') is written
  //   IMMEDIATELY after fire-and-forget dispatch, BEFORE the sync-poll loop
  //   that can pin a lambda for ~580s. Captures wallets_targeted=1 +
  //   dispatched_per_collection (fire-side only at this point; sync collections
  //   default to 0 = pending) + dispatch_errors_per_collection. Guarantees we
  //   always see what was dispatched even if the lambda gets killed mid-sync.
  //
  //   END row (pipeline='wallet-backfill-multicollection-final') is written at
  //   the END of after() with the full sync picture (sync_round_trips_actual,
  //   sync_completed_collections). Pair START → END at query time via
  //   extra->>'wallet_address'; START with no matching END = killed lambda.
  //
  //   wallet_address is the canonical extra key (matches the Round 11
  //   verification query). Legacy 'wallet' key dropped — telemetry consumers
  //   should migrate to wallet_address.
  const startedAtIso = new Date().toISOString()
  after(async () => {
    const t0 = Date.now()

    // ---- Phase 1: fire-and-forget dispatch (parallel) ----
    const fireResults = await Promise.all(
      FIRE_AND_FORGET_COLLECTIONS.map(t => fireOnce(origin, t, wallet, skipCached, ingestToken))
    )
    const fireMs = Date.now() - t0

    // Build dispatch-time snapshot. Sync collections marked 0 (= pending).
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

    // ---- START telemetry row ----
    // Write BEFORE the sync-poll loop. If the lambda dies during sync, this
    // row still exists and pinpoints the casualty by absence of the END row.
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "wallet-backfill-multicollection",
        p_started_at: startedAtIso,
        p_rows_found: 1,
        p_rows_written: Object.values(dispatched).filter(v => v > 0).length,
        p_rows_skipped: Object.values(dispatchErrors).reduce((a, b) => a + b, 0),
        p_ok: Object.values(dispatchErrors).length === 0,
        p_error: null,
        p_collection_slug: null,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          wallet_address: wallet,
          wallets_targeted: 1,
          phase: "dispatch",
          dispatched_per_collection: dispatched,
          dispatch_errors_per_collection: dispatchErrors,
          dispatch_error_samples: dispatchErrorSamples,
          fire_ms: fireMs,
          sync_collections_pending: SYNC_COLLECTIONS.map(t => t.slug),
          sync_round_trip_cap: SYNC_ROUND_TRIP_CAP,
        },
      })
    } catch (logErr) {
      console.warn(
        `[wallet-backfill-multicollection] log_pipeline_run (start) failed wallet=${wallet}: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      )
    }

    // ---- Phase 2: sync-poll loop ----
    const syncResults: SyncResult[] = []
    for (const target of SYNC_COLLECTIONS) {
      syncResults.push(await syncPoll(origin, target, wallet, skipCached, ingestToken))
    }
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
    }))
    const syncCompletedCollections = syncResults.filter(r => r.final_complete).map(r => r.collection)

    // ---- END telemetry row ----
    // Distinct pipeline name so START/END pair cleanly at query time.
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: "wallet-backfill-multicollection-final",
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
          phase: "final",
          dispatched_per_collection: dispatched,
          dispatch_errors_per_collection: dispatchErrors,
          dispatch_error_samples: dispatchErrorSamples,
          fire_ms: fireMs,
          total_ms: totalMs,
          sync_round_trips_actual: syncRoundTripsActual,
          sync_completed_collections: syncCompletedCollections,
        },
      })
    } catch (logErr) {
      console.warn(
        `[wallet-backfill-multicollection] log_pipeline_run (final) failed wallet=${wallet}: ${logErr instanceof Error ? logErr.message : String(logErr)}`
      )
    }
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
