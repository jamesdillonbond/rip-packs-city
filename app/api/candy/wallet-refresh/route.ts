// app/api/candy/wallet-refresh/route.ts
//
// POST /api/candy/wallet-refresh  { wallet: "<base58 Candy Wallet address>" }
//
// Reads ONE Candy wallet live from Solana and rewrites its wallet_moments_cache rows,
// so a collector who pastes their Candy Wallet address on the Candy MLB Collection tab
// sees what the wallet holds NOW — not what the daily census (5:10 PM PT) saw. Before
// this route, a card bought or pulled today was missing, a card sold today was still
// shown, and a wallet created since the last census showed nothing at all.
//
// The walk is lib/candy/refresh-wallet.ts — the same steps as the bearer-gated
// /api/wallet-backfill-candy (fired when a signed-in user saves a wallet), which still
// carries its own copy; moving that route onto this lib is a follow-up. This route adds
// retirement: only after a COMPLETE walk
// are the wallet's untouched rows (cards it no longer holds) retired. An incomplete
// walk retires nothing and says so (`complete: false`), and the tab then tells the
// reader it is showing the last daily read.
//
// Anon-public (the Collection tab is). Writes only what the chain says this wallet
// holds. Bounded three ways: a per-client limit, a per-wallet cooldown, and a time
// budget inside the walk.
//
//   200 { ok: true, complete, found, retired }      — walked (complete or not)
//   200 { ok: true, skipped: "fresh" }               — refreshed in the last few minutes
//   400 { error: "not_a_solana_address" }
//   429 { error: "rate_limited" }
//   503 { error: "refresh_unavailable" }             — the walk could not start

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { refreshCandyWallet } from "@/lib/candy/refresh-wallet"
import { candyDiscoveryReady, CANDY_MLB_SLUG } from "@/lib/chains/solana/normalize"
import { isValidAddressForChain } from "@/lib/address"
import { makeInstanceRateLimiter, clientKeyFrom } from "@/lib/http/instance-rate-limit"

export const dynamic = "force-dynamic"
export const maxDuration = 60

const PIPELINE_NAME = "candy-wallet-refresh"
// A collector searches a handful of wallets; this is browsing, not enumeration.
const REFRESHES_PER_CLIENT_PER_MINUTE = 6
const limiter = makeInstanceRateLimiter({ limit: REFRESHES_PER_CLIENT_PER_MINUTE, windowMs: 60_000 })
// One wallet is re-walked at most once per this window per instance.
const WALLET_COOLDOWN_MS = 3 * 60_000
const recentWalks = new Map<string, number>()
const WALK_BUDGET_MS = 40_000

function noteWalk(wallet: string, at: number) {
  recentWalks.set(wallet, at)
  if (recentWalks.size > 5000) {
    const oldest = recentWalks.keys().next().value
    if (oldest !== undefined) recentWalks.delete(oldest)
  }
}

export async function POST(req: NextRequest) {
  let body: { wallet?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 })
  }
  // base58 is case-sensitive: never fold or prefix it.
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : ""
  if (!wallet || !isValidAddressForChain(wallet, "solana")) {
    return NextResponse.json(
      { error: "not_a_solana_address", message: "Paste the wallet address from your Candy account (wallet.candy.io)." },
      { status: 400 },
    )
  }

  const clientKey = clientKeyFrom(req.headers)
  if (clientKey) {
    const v = limiter.check(clientKey)
    if (!v.allowed) {
      return NextResponse.json(
        { error: "rate_limited", retry_after_seconds: v.retryAfterSeconds },
        { status: 429, headers: { "Retry-After": String(v.retryAfterSeconds) } },
      )
    }
  }

  const now = Date.now()
  const last = recentWalks.get(wallet)
  if (last !== undefined && now - last < WALLET_COOLDOWN_MS) {
    return NextResponse.json({ ok: true, skipped: "fresh" })
  }

  if (!candyDiscoveryReady()) {
    return NextResponse.json({ error: "refresh_unavailable", reason: "discovery_pending" }, { status: 503 })
  }

  noteWalk(wallet, now)
  const startedAtIso = new Date(now).toISOString()
  let result
  try {
    result = await refreshCandyWallet(supabaseAdmin, wallet, { retire: true, deadlineAt: now + WALK_BUDGET_MS })
  } catch (e) {
    recentWalks.delete(wallet)
    console.log(`[${PIPELINE_NAME}] walk threw: ${e instanceof Error ? e.message : String(e)}`)
    return NextResponse.json({ error: "refresh_unavailable" }, { status: 503 })
  }
  if (!result.complete) recentWalks.delete(wallet) // let the reader retry a partial walk

  const errorText =
    result.walk_error ??
    (result.write_errors.length ? result.write_errors.slice(0, 3).join(" | ") : null) ??
    result.escrow_listed_error ??
    result.retire_error
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: result.found,
      p_rows_written: result.written,
      p_rows_skipped: 0,
      p_ok: result.complete && result.retire_error === null,
      p_error: errorText ? String(errorText).slice(0, 500) : null,
      p_collection_slug: CANDY_MLB_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: { wallet, ...result, duration_ms: Date.now() - now },
    })
  } catch {
    // Logging is best-effort; the reader's answer does not depend on it.
  }

  return NextResponse.json({
    ok: true,
    complete: result.complete,
    found: result.found,
    retired: result.retired,
    // Older Candy collectibles RPC does not catalogue, so "0 moments" is never read as
    // "holds nothing" (null when the check could not run).
    other_candy: result.other_candy
      ? { items: result.other_candy.items, collections: result.other_candy.collections.slice(0, 5) }
      : null,
  })
}
