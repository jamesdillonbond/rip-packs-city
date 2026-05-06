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
// Per-collection coverage (May 6, 2026):
//   - nba_top_shot   → /api/wallet-backfill         (Cadence + GQL)
//   - nfl_all_day    → /api/wallet-backfill-allday  (Cadence)
//   - disney_pinnacle → SKIP (no Cadence path yet — pinnacle-wallet route
//     reads from cached pinnacle data populated by ingest, not by
//     wallet-side Cadence walks). Follow-up: build wallet-backfill-pinnacle
//     once the Pinnacle ingest pattern is mirrored on the wallet axis.
//   - laliga_golazos → SKIP (Flowty-only listings; per-wallet enrichment
//     is not yet wired). Follow-up.
//   - ufc_strike     → SKIP (existing enrich-ufc-wallet edge function is
//     sale-trigger-driven, not full-wallet-walk). Follow-up: extend it to
//     accept a public { wallet } body for parity with TS / AllDay.
//
// As each collection's per-wallet enricher lands, append it to
// COLLECTIONS_TO_FAN_OUT below — no schema or orchestrator changes needed.

import { NextRequest, NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 30

interface FanoutTarget {
  slug: string
  path: string
}

const COLLECTIONS_TO_FAN_OUT: FanoutTarget[] = [
  { slug: "nba_top_shot", path: "/api/wallet-backfill" },
  { slug: "nfl_all_day", path: "/api/wallet-backfill-allday" },
  // disney_pinnacle, laliga_golazos, ufc_strike pending — see header.
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
      pending_collections: ["disney_pinnacle", "laliga_golazos", "ufc_strike"],
      note:
        "Disney Pinnacle, LaLiga Golazos, and UFC Strike per-wallet enrichers are not yet built. Top Shot + AllDay land via this fan-out today.",
    },
    { status: 202 }
  )
}
