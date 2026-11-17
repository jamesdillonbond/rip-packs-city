// app/api/public/trades/compare/route.ts
//
// /trades/compare's read (2026-11-16): two Top Shot usernames (or Flow addresses) in, the
// Moments each could trade the other out. Public, no sign-in — RPC asks for identifiers, never a
// wallet connect, to READ (rpc-no-wallet-signin).
//
//   GET ?u1=<username|0x…>&u2=<username|0x…>[&c=nba-top-shot|nfl-all-day|laliga-golazos]
//     -> { collection, a: Side, b: Side, quick_trade: QuickTrade | null, checked_at }
//   (2026-11-16 afternoon: All Day and Golazos too. One Dapper wallet holds all three, so a Top
//    Shot username names the wallet. An unknown `c` is REFUSED (400), never answered as Top Shot —
//    the substitution rule; an ABSENT `c` defaults to Top Shot.)
//
// Side = { username, editions[], editions_total, candidates_total, capped, blocked, coverage }
//
// Order of truth: RPC's index names the CANDIDATES (get_trade_compare); the CHAIN decides
// what is tradeable (held, unlocked, not listed). A failed chain read is a 503 — never a list
// of unverified Moments, never "nothing to trade". An unknown username is a 404 by name; a
// lookup that FAILED is a 503 (never "no such user").
//
// Usernames are matched case-insensitively (thetradefloor answered "No Top Shot user" for
// "jamesdillonbond" because it wanted "Jamesdillonbond"); the reply carries the canonical spelling.
// No wallet address ever leaves the server. FMV confidence tiers never leave the server.
//
// The compare itself lives in lib/trade-compare/run.ts (2026-11-16 evening), shared with the
// concierge's compare_collections tool; this route keeps the rate limits, the budget, the walk
// dispatch and the HTTP shapes.
//
// Durable anon caps (lib/abuse/anon-rate.ts, fail closed): one compare fans out to ~25 Flow REST
// calls, so per IP 30/h and globally 600/h. When a wallet's index is SHORT of its on-chain count,
// the Top Shot walk is dispatched (per wallet once per 6 h, globally 60/h) and the page says so.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { boardUnavailable } from "@/lib/insights/board-error"
import { anonIpKey, bumpAnonRates } from "@/lib/abuse/anon-rate"
import { compareCollection } from "@/lib/trade-compare/read"
import { isCompareIdentifier, runCompare, UpstreamError } from "@/lib/trade-compare/run"
import type { SwapCollection } from "@/lib/trade-room/multi-swap-cadence"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"


export const dynamic = "force-dynamic"
export const maxDuration = 60
/** The whole compare (DB + ~25 chain calls) is bounded under maxDuration so the 503 can still be sent. */
const COMPARE_BUDGET_MS = 50_000

function upstream503(message: string): NextResponse {
  return NextResponse.json(
    { error: message, code: "upstream_unavailable", retryable: true },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "30" } },
  )
}

async function dispatchWalk(req: NextRequest, wallet: string, c: SwapCollection): Promise<boolean> {
  // the walk dispatched here is Top Shot's (fire-and-forget); All Day's is a long SYNC walk owned
  // by the multicollection orchestrator, so a short All Day / Golazos index is said, not walked
  if (c.slug !== "nba-top-shot") return false
  const token = process.env.INGEST_SECRET_TOKEN
  if (!token) return false
  const verdict = await bumpAnonRates([
    { bucket: "trade_compare_walk:global", key: "*", limit: 60, windowSecs: 3600 },
    { bucket: "trade_compare_walk:wallet", key: wallet, limit: 1, windowSecs: 6 * 3600 },
  ])
  if (!verdict.allowed) return verdict.refusedBucket === "trade_compare_walk:wallet" && !verdict.failed
  const origin = new URL(req.url).origin
  after(async () => {
    try {
      await fetch(`${origin}/api/wallet-backfill`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ wallet }),
        // fire-and-forget: the walk keeps running server-side; this only lets THIS lambda exit
        signal: AbortSignal.timeout(45_000),
      })
    } catch {
      /* best-effort; the page already says the index is short */
    }
  })
  return true
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const u1 = (sp.get("u1") ?? "").trim()
  const u2 = (sp.get("u2") ?? "").trim()
  const c = compareCollection(sp.get("c") ?? "nba-top-shot")
  if (!c) return NextResponse.json({ error: "Compare covers NBA Top Shot, NFL All Day and LaLiga Golazos.", code: "bad_collection" }, { status: 400 })
  for (const u of [u1, u2]) {
    if (!u || !isCompareIdentifier(u)) {
      return NextResponse.json({ error: "Enter two Top Shot usernames.", code: "bad_input" }, { status: 400 })
    }
  }

  const ip = anonIpKey(req.headers)
  const verdict = await bumpAnonRates([
    { bucket: "trade_compare:global", key: "*", limit: 600, windowSecs: 3600 },
    ...(ip ? [{ bucket: "trade_compare:ip", key: ip, limit: 30, windowSecs: 3600 }] : []),
  ])
  if (!verdict.allowed) {
    if (verdict.failed) return upstream503("Compare isn't available right now. Try again in a moment.")
    return NextResponse.json({ error: "Too many compares from here in the last hour. Try again later.", code: "rate_limited" }, { status: 429 })
  }

  try {
    return await withBoardBudget(compare(req, c, u1, u2), "compare", COMPARE_BUDGET_MS, "trades/")
  } catch (e) {
    if (e instanceof UpstreamError) {
      console.warn(`[trades/compare] ${e.message}`)
      return upstream503("We couldn't read those collections from the Flow blockchain or Top Shot just now. This is temporary, not an empty result — try again in a moment.")
    }
    return boardUnavailable(e, "trades-compare", "We couldn't check those collections right now. Try again in a moment.")
  }
}

async function compare(req: NextRequest, c: SwapCollection, u1: string, u2: string): Promise<NextResponse> {
  const out = await runCompare(supabaseAdmin, c, u1, u2, { onShortIndex: (wallet, coll) => dispatchWalk(req, wallet, coll) })
  if (out.kind === "not_found") {
    return NextResponse.json({ error: `No Top Shot collector named "${out.username}".`, code: "not_found", username: out.username }, { status: 404 })
  }
  if (out.kind === "same_wallet") {
    return NextResponse.json({ error: "Those are the same collector. Enter two different usernames.", code: "same_wallet" }, { status: 400 })
  }
  return NextResponse.json(out.result, { headers: { "Cache-Control": "no-store" } })
}
