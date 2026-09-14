// app/api/profile/verify-challenge/signature/route.ts
//
// Wallet verification by SIGNATURE — the fast path, beside the listing
// challenge in ../route.ts rather than replacing it.
//
//   GET  ?wallet_addr=0x…   -> { address, issuedAt, nonce, message, messageHex }
//   POST { wallet_addr, issuedAt, nonce, signatures } -> verified, or why not
//
// The user's wallet signs four readable lines; FCLCrypto on Flow mainnet says
// whether that signature is the address's own; RPC records the verification.
// No transaction, no listing, no key, no Dapper business relationship, and
// nothing about the challenge is stored before it is answered (the nonce is an
// HMAC the server recomputes). See lib/auth/flow-signature.ts for why this is
// possible at all, and for the 2026-08-08 decision it re-derives.
//
// WHAT THIS ROUTE DOES NOT DO: connect a wallet. It verifies a signature the
// caller already has. Obtaining one needs an FCL client surface, which RPC
// still does not have and which __tests__/no-client-wallet-connect.test.ts
// still forbids — that invariant is Trevor's and is his to lift. Until then
// this route is reachable by anything that can produce an FCL user signature
// (the RPC MCP tools, a console, a future connect button) and the listing
// challenge remains the only in-product path.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { apiErrorResponse, errorLogDetail } from "@/lib/api-error"
import {
  makeChallenge,
  verifyWalletSignature,
  normalizeFlowAddress,
  FlowVerifyUnavailable,
  CHALLENGE_TTL_MS,
} from "@/lib/auth/flow-signature"

export const dynamic = "force-dynamic"
export const maxDuration = 30

// Per-user rate limit. Each POST costs one Cadence script against a public
// access node; be a good citizen and make brute-forcing a nonce pointless.
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 10
const rateHits = new Map<string, number[]>()

function rateLimited(userId: string): boolean {
  const now = Date.now()
  const arr = (rateHits.get(userId) ?? []).filter((t) => now - t < RATE_WINDOW_MS)
  if (arr.length >= RATE_MAX) {
    rateHits.set(userId, arr)
    return true
  }
  arr.push(now)
  rateHits.set(userId, arr)
  return false
}

/**
 * The wallet must already be SAVED to this account. The signature proves
 * control of the address; it does not prove the address is one this user
 * asked us to associate. Requiring the saved row keeps the two claims
 * separate, and matches what the listing challenge does.
 */
async function savedWalletFor(userId: string, wallet: string) {
  const { data, error } = await supabase
    .from("saved_wallets")
    .select("id, wallet_addr, verified_at")
    .eq("user_id", userId)
    .ilike("wallet_addr", wallet)
    .maybeSingle()
  if (error) throw error
  return data as { id: number; wallet_addr: string; verified_at: string | null } | null
}

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const wallet = normalizeFlowAddress(req.nextUrl.searchParams.get("wallet_addr"))
  if (!wallet) {
    return NextResponse.json({ error: "A Flow address (0x + 16 hex) is required." }, { status: 400 })
  }

  try {
    const saved = await savedWalletFor(user.id, wallet)
    if (!saved) {
      return NextResponse.json({ error: "Save this wallet to your account first." }, { status: 404 })
    }
    if (saved.verified_at) {
      return NextResponse.json({ already_verified: true, wallet_addr: wallet, verified_at: saved.verified_at })
    }

    const challenge = makeChallenge(wallet)
    if (!challenge) {
      return NextResponse.json({ error: "A Flow address (0x + 16 hex) is required." }, { status: 400 })
    }
    return NextResponse.json({
      ...challenge,
      // The client should refetch rather than let a user sign something the
      // server will refuse; surfaced so the caller does not hardcode our TTL.
      expiresInMs: CHALLENGE_TTL_MS,
    })
  } catch (err) {
    console.error("[verify-signature GET]", errorLogDetail(err))
    return apiErrorResponse(err, "Could not start wallet verification.")
  }
}

export async function POST(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  if (rateLimited(user.id)) {
    return NextResponse.json({ error: "Too many attempts. Wait a minute and try again." }, { status: 429 })
  }

  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 })
  }

  const wallet = normalizeFlowAddress(body.wallet_addr ?? body.address)
  if (!wallet) {
    return NextResponse.json({ error: "A Flow address (0x + 16 hex) is required." }, { status: 400 })
  }

  try {
    const saved = await savedWalletFor(user.id, wallet)
    if (!saved) {
      return NextResponse.json({ error: "Save this wallet to your account first." }, { status: 404 })
    }
    if (saved.verified_at) {
      return NextResponse.json({ ok: true, already_verified: true, wallet_addr: wallet, verified_at: saved.verified_at })
    }

    let outcome
    try {
      outcome = await verifyWalletSignature({
        address: wallet,
        issuedAt: body.issuedAt,
        nonce: body.nonce,
        signatures: body.signatures as never,
      })
    } catch (err) {
      if (err instanceof FlowVerifyUnavailable) {
        // THREE STATES: this is "we could not ask", never "your wallet failed".
        // Rendering an access-node outage as a rejected signature would be the
        // account-level false claim this codebase keeps having to fix.
        console.error("[verify-signature chain]", errorLogDetail(err))
        return NextResponse.json(
          {
            ok: false,
            unavailable: true,
            error: "Could not reach Flow to check the signature. Nothing was changed — try again shortly.",
          },
          { status: 503 }
        )
      }
      throw err
    }

    if (!outcome.ok) {
      return NextResponse.json({ ok: false, code: outcome.code, error: outcome.error }, { status: 400 })
    }

    // Atomic: stamp verified_at + verification_method, award link_wallet once,
    // and pay a referral only on a genuinely-first verification. Mirrors
    // resolve_wallet_challenge_match (which hardcodes 'listing_challenge') so
    // the two paths cannot diverge on awards.
    const { data: resolved, error: rErr } = await supabase.rpc("resolve_wallet_signature_match", {
      p_user_id: user.id,
      p_wallet: wallet,
      p_referrer: typeof body.referrer === "string" ? body.referrer : null,
    })
    if (rErr) throw rErr

    const r = (resolved ?? {}) as Record<string, unknown>
    if (r.ok !== true) {
      return NextResponse.json({ ok: false, error: String(r.error ?? "Could not record the verification.") }, { status: 409 })
    }

    return NextResponse.json({
      ok: true,
      wallet_addr: wallet,
      verified_via: "wallet_signature",
      first_verification: r.first_verification === true,
      link_wallet_award: r.link_wallet_award ?? null,
      referral_award: r.referral_award ?? null,
    })
  } catch (err) {
    console.error("[verify-signature POST]", errorLogDetail(err))
    return apiErrorResponse(err, "Could not verify the wallet.")
  }
}
