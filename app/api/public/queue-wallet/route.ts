// POST /api/public/queue-wallet
//
// Public, anon-reachable (under /api/public/* → proxy.ts bypass). Accepts a
// Flow address, validates it, and fires the existing wallet-backfill
// orchestrator in after() so an unindexed wallet starts indexing the moment a
// visitor pastes it on /share. Returns 202 immediately — the caller polls
// /api/collection-snapshot for the result.
//
// Risk posture: this kicks off the SAME backfill a logged-in user already
// triggers (and the 6-hour seed-refresh cron already runs platform-wide). It
// takes no amount/credential and writes nothing itself — it only dispatches the
// service-role orchestrator with the platform INGEST token, which never leaves
// the server. skip_cached=true makes already-indexed wallets near-no-ops.
//
// A small per-instance recent-wallet guard avoids re-dispatching the heavy
// orchestrator for the same wallet on rapid repeat submits.
//
// ⛔ DURABLE CAPS (2026-10-10). "The edge limiter in front of /api/public/* is
// the real rate ceiling" was not true: proxy.ts's limiter is per lambda and in
// memory, and one request here fans out to ~6 long lambdas (the orchestrator plus
// five per-collection backfills). Random valid addresses never repeat, so the
// per-instance dedup never fired for them. Three durable caps now sit in front of
// the dispatch (lib/abuse/anon-rate.ts), and they FAIL CLOSED: per wallet one
// dispatch per 6 h, per IP 20/h, globally 300/h.

import { NextRequest, NextResponse, after } from "next/server"
import { anonIpKey, bumpAnonRates } from "@/lib/abuse/anon-rate"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const FLOW_ADDRESS = /^0x[0-9a-fA-F]{16}$/

// Per-instance dedup: wallet → last-dispatched epoch ms. Best-effort only
// (serverless instances aren't shared), enough to swallow a poll loop or a
// double-submit from one client hitting the same warm instance.
const RECENT = new Map<string, number>()
const DEDUP_TTL_MS = 5 * 60_000

function recentlyQueued(wallet: string): boolean {
  const now = Date.now()
  // Opportunistic prune so the map can't grow unbounded.
  if (RECENT.size > 5000) {
    for (const [k, t] of RECENT) if (now - t > DEDUP_TTL_MS) RECENT.delete(k)
  }
  const last = RECENT.get(wallet)
  return last != null && now - last < DEDUP_TTL_MS
}

export async function POST(req: NextRequest) {
  let body: { wallet?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }

  const wallet = (body.wallet || "").trim().toLowerCase()
  if (!FLOW_ADDRESS.test(wallet)) {
    return NextResponse.json({ error: "invalid_wallet" }, { status: 400 })
  }

  const ingestToken = process.env.INGEST_SECRET_TOKEN
  if (!ingestToken) {
    // Misconfig — don't 500 the visitor; report not-queued so the client falls
    // back to its retry box instead of spinning forever.
    return NextResponse.json({ queued: false, reason: "unavailable" }, { status: 202 })
  }

  if (recentlyQueued(wallet)) {
    return NextResponse.json({ queued: true, wallet, deduped: true }, { status: 202 })
  }

  const ip = anonIpKey(req.headers)
  const verdict = await bumpAnonRates([
    { bucket: "queue_wallet:wallet", key: wallet, limit: 1, windowSecs: 6 * 3600 },
    ...(ip ? [{ bucket: "queue_wallet:ip", key: ip, limit: 20, windowSecs: 3600 }] : []),
    { bucket: "queue_wallet:global", key: "*", limit: 300, windowSecs: 3600 },
  ])
  if (!verdict.allowed) {
    if (verdict.refusedBucket === "queue_wallet:wallet" && !verdict.failed) {
      // Dispatched within the last 6 h — the walk is already running or done.
      RECENT.set(wallet, Date.now())
      return NextResponse.json({ queued: true, wallet, deduped: true }, { status: 202 })
    }
    return NextResponse.json(
      { queued: false, wallet, reason: verdict.failed ? "unavailable" : "rate_limited" },
      { status: verdict.failed ? 202 : 429 },
    )
  }
  RECENT.set(wallet, Date.now())

  const origin = new URL(req.url).origin

  after(async () => {
    try {
      await fetch(origin + "/api/wallet-backfill-multicollection", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ingestToken}`,
        },
        body: JSON.stringify({ wallet, skip_cached: true }),
        // 45s cap, derived from this route's own `maxDuration = 60` rather than
        // from any claim about the peer.
        //
        // ⚠ The peer is an INTERNAL route, which the class triage lists as a
        // legitimate reason to be unbounded — but that reason does NOT apply
        // here: the peer carries a much larger maxDuration than this caller, so
        // waiting on it can outlive THIS lambda, and a kill inside `after()`
        // runs neither the success path nor the `catch` below.
        //
        // ⭐ Aborting is free of consequence because the response is never read:
        // this is fire-and-forget, the 202 has already gone back to the visitor,
        // and the peer lambda keeps running server-side regardless of whether
        // this side is still listening. The bound only makes THIS lambda exit
        // cleanly instead of being killed.
        signal: AbortSignal.timeout(45_000),
      })
    } catch {
      // Best-effort — the visitor's poll loop just keeps showing "analyzing"
      // until it times out and offers a retry.
    }
  })

  return NextResponse.json({ queued: true, wallet }, { status: 202 })
}
