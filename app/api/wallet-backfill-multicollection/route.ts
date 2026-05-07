// app/api/wallet-backfill-multicollection/route.ts
//
// Orchestrator that fans out to every per-collection enrichment route in
// parallel. Used by the allow-list approval / new-wallet onboarding flow
// so first-time invitees see their portfolio across every published
// collection on their first sign-in.
//
// Each child returns 202 immediately (after()-backed Cadence walks), so
// this orchestrator is fast — fan-out is mostly fetch-latency bound, not
// enrichment-latency bound.
//
// Per-collection coverage (May 7, 2026):
//   - nba_top_shot   → /api/wallet-backfill            (Cadence + GQL)
//   - nfl_all_day    → /api/wallet-backfill-allday     (Cadence, ID-only)
//   - disney_pinnacle → /api/wallet-backfill-pinnacle  (Cadence, ID-only)
//   - laliga_golazos → /api/wallet-backfill-golazos    (Cadence, ID-only)
//   - ufc_strike     → /api/wallet-backfill-ufc        (Cadence, ID-only)
//
// All five collections now flow through this orchestrator. The non-TS
// enrichers write IDs only; player / set / tier come from out-of-band
// edition resolvers via JOIN at query time.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 30

interface FanoutTarget {
  slug: string
  path: string
}

const COLLECTIONS_TO_FAN_OUT: FanoutTarget[] = [
  { slug: "nba_top_shot",    path: "/api/wallet-backfill" },
  { slug: "nfl_all_day",     path: "/api/wallet-backfill-allday" },
  { slug: "disney_pinnacle", path: "/api/wallet-backfill-pinnacle" },
  { slug: "laliga_golazos",  path: "/api/wallet-backfill-golazos" },
  { slug: "ufc_strike",      path: "/api/wallet-backfill-ufc" },
]

interface FanoutResult {
  collection: string
  status: number
  ok: boolean
  body?: unknown
  error?: string
}

async function fireOne(origin: string, target: FanoutTarget, wallet: string, skipCached: boolean, ingestToken: string): Promise<FanoutResult> {
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

  // Fan out in parallel. Each child uses after() so they all return
  // ~immediately; the orchestrator is bounded by network latency, not
  // enrichment time.
  const results = await Promise.all(
    COLLECTIONS_TO_FAN_OUT.map(t => fireOne(origin, t, wallet, skipCached, ingestToken))
  )

  const accepted = results.filter(r => r.ok).length
  return NextResponse.json(
    {
      wallet_address: wallet,
      skip_cached: skipCached,
      accepted_count: accepted,
      collection_count: COLLECTIONS_TO_FAN_OUT.length,
      results,
    },
    { status: 202 }
  )
}
