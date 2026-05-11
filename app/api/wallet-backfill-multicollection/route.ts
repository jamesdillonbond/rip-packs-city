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

export const dynamic = "force-dynamic"
// Bumped from 30s to 600s — the orchestrator now blocks on sync-mode
// AllDay + Pinnacle children inside its own after() task. Each child
// round-trip is bounded at SYNC_MAX_DURATION_MS so the worst case is
// (ceil(on_chain_count / chunk_size) / chunks_per_round) round-trips
// per wallet × 270s each. Mega-wallet pinnacle (~7700 NFTs at 500/chunk
// = 16 chunks, ~8s/chunk = ~130s) finishes in a single round-trip.
export const maxDuration = 600

const SYNC_MAX_DURATION_MS = 270_000
const SYNC_ROUND_TRIP_CAP = 6 // safety: max retries per (wallet, sync collection)

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
  after(async () => {
    const t0 = Date.now()
    const fireResults = await Promise.all(
      FIRE_AND_FORGET_COLLECTIONS.map(t => fireOnce(origin, t, wallet, skipCached, ingestToken))
    )
    const fireMs = Date.now() - t0

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
