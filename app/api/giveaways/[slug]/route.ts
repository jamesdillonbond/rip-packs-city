// app/api/giveaways/[slug]/route.ts
//
// Public giveaway drop.
//   GET  -> PublicDropView (lib/giveaways/store.ts). Anyone may read a sealed,
//           open or closed drop; a draft is a 404. When signed in, `me` carries
//           the viewer's own pack. `signed_in` says which case `me: null` is.
//   GET  ?claim_nonce=1 -> { nonce, issuedAt } for Flow Wallet's account proof,
//           bound to the signed-in user (lib/giveaways/claim-proof.ts). Signed in.
//   POST { username, agree: true } -> claim one pack (signed in; any account —
//           claims do not need allow-list approval, see proxy.ts).
//   POST { intent: "accounts", proof } -> { accounts }: where a winner who
//           connected Flow Wallet can have their pack sent: that wallet and every
//           account it has linked (Hybrid Custody, redeemed, read on chain), each
//           with whether it can receive Top Shot moments.
//   POST { proof, destination, agree: true } -> claim with Flow Wallet (Trevor,
//           2026-10-03). `proof` is the wallet's FCL account proof: it must
//           verify on chain for THIS user and THIS site before anything else is
//           read, so nobody can name someone else's wallet. `destination` must be
//           that wallet or an account it has linked, with a Top Shot collection.
//
// The claim resolves the Top Shot username to its Flow wallet (the delivery
// target the admin gifts to in the Top Shot app) and draws a uniformly random
// unclaimed pack in the database (claim_giveaway_pack).

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve"
import { buildPublicView, claimPack, getClaims, getDrop, getPool, usernameForWallet } from "@/lib/giveaways/store"
import { claimOutcomeResponse } from "@/lib/giveaways/claim-copy"
import { discoverAccounts } from "@/lib/giveaways/linked-accounts"
import { issueClaimNonce, verifyClaimProof, type ClaimProofInput } from "@/lib/giveaways/claim-proof"

export const dynamic = "force-dynamic"

const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/
const USERNAME = /^@?[A-Za-z0-9_.-]{2,40}$/
const FLOW_ADDRESS = /^0x[0-9a-f]{16}$/

/** A chain read we could not complete: never reported as "not linked" or "can't receive". */
function chainUnavailable() {
  return NextResponse.json(
    { error: "We couldn't reach the Flow blockchain to check your wallet. Try again in a minute.", code: "upstream_unavailable", retryable: true },
    { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } },
  )
}

type Ctx = { params: Promise<{ slug: string }> }

const NO_STORE = { "Cache-Control": "no-store" }

// Each proof check costs one Cadence script on a public access node; per-user cap.
const PROOF_WINDOW_MS = 60_000
const PROOF_MAX = 10
const proofHits = new Map<string, number[]>()
function proofRateLimited(userId: string, now = Date.now()): boolean {
  const hits = (proofHits.get(userId) ?? []).filter((t) => now - t < PROOF_WINDOW_MS)
  const limited = hits.length >= PROOF_MAX
  if (!limited) hits.push(now)
  proofHits.set(userId, hits)
  return limited
}

/** Test hook: the rate-limit window is module state. */
export function __resetProofRateLimit() {
  proofHits.clear()
}

/**
 * The Flow Wallet this user PROVED they control, or the response to send. The
 * page's own origin is the account proof's appIdentifier (FCL signs
 * window.location.origin), and the claim page is served from this origin.
 */
async function provenWallet(req: NextRequest, userId: string, proof: unknown): Promise<{ wallet: string } | { res: NextResponse }> {
  if (proofRateLimited(userId)) {
    return { res: NextResponse.json({ error: "Too many tries. Wait a minute and try again.", code: "rate_limited" }, { status: 429, headers: { ...NO_STORE, "Retry-After": "60" } }) }
  }
  try {
    const out = await verifyClaimProof(userId, req.nextUrl.origin, proof as ClaimProofInput | null)
    if (!out.ok) return { res: NextResponse.json({ error: out.error, code: out.code }, { status: 400, headers: NO_STORE }) }
    return { wallet: out.address }
  } catch {
    return { res: chainUnavailable() }
  }
}

async function accountsFor(wallet: string) {
  try {
    const accounts = (await discoverAccounts(wallet)).map((a) => ({ address: a.address, role: a.role, can_receive: a.topshot_count != null }))
    return NextResponse.json({ wallet, accounts }, { headers: NO_STORE })
  } catch {
    return chainUnavailable()
  }
}

export async function GET(req: NextRequest, ctx: Ctx) {
  const { slug } = await ctx.params
  if (!SLUG.test(slug)) return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
  if (req.nextUrl.searchParams.has("claim_nonce")) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Sign in to claim a pack.", code: "sign_in" }, { status: 401, headers: NO_STORE })
    try {
      return NextResponse.json(issueClaimNonce(user.id), { headers: NO_STORE })
    } catch (err) {
      return apiErrorResponse(err, "api/giveaways/[slug] GET claim_nonce", "We couldn't start the Flow Wallet sign-in. Try again in a moment.")
    }
  }
  try {
    const drop = await getDrop(supabaseAdmin, { slug })
    if (!drop || drop.status === "draft") {
      return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
    }
    const user = await getCurrentUser()
    const [pool, claims] = await Promise.all([getPool(supabaseAdmin, drop.id), getClaims(supabaseAdmin, drop.id)])
    const view = buildPublicView(drop, pool, claims, user?.id ?? null)
    if (!view) return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
    return NextResponse.json({ ...view, signed_in: user != null }, { headers: NO_STORE })
  } catch (err) {
    return apiErrorResponse(err, "api/giveaways/[slug] GET", "We couldn't load this giveaway. Try again in a moment.")
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  const { slug } = await ctx.params
  if (!SLUG.test(slug)) return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
  const user = await getCurrentUser()
  if (!user) return NextResponse.json({ error: "Sign in to claim a pack.", code: "sign_in" }, { status: 401, headers: NO_STORE })

  let body: { username?: unknown; agree?: unknown; wallet?: unknown; destination?: unknown; intent?: unknown; proof?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Enter your Top Shot username.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  if (body?.intent === "accounts") {
    const proven = await provenWallet(req, user.id, body.proof)
    return "res" in proven ? proven.res : accountsFor(proven.wallet)
  }
  if (body?.agree !== true) {
    return NextResponse.json({ error: "Confirm you are 18 or older and agree to the official rules.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  if (body.proof !== undefined || body.wallet !== undefined) return claimWithWallet(req, slug, user.id, body)
  const username = typeof body.username === "string" ? body.username.trim() : ""
  if (!USERNAME.test(username)) {
    return NextResponse.json({ error: "Enter your Top Shot username.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }

  try {
    const drop = await getDrop(supabaseAdmin, { slug })
    if (!drop || drop.status === "draft") {
      return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
    }
    if (drop.status !== "open") return claimOutcomeResponse("not_open", null)

    const resolved = await resolveTopShotUsernameCacheAware(supabaseAdmin, username)
    if (!resolved.found) {
      if (resolved.reason === "topshot_gql_error") {
        // could not LOOK — never reported as "no such user"
        return NextResponse.json(
          { error: "We couldn't reach Top Shot to check that username. Try again in a minute.", code: "upstream_unavailable", retryable: true },
          { status: 503, headers: { ...NO_STORE, "Retry-After": "30" } },
        )
      }
      return NextResponse.json({ error: "We couldn't find that Top Shot username. Check the spelling.", code: "not_found" }, { status: 400, headers: NO_STORE })
    }
    const recipient = resolved.walletAddress.toLowerCase()
    if (!/^0x[0-9a-f]{16}$/.test(recipient)) {
      return NextResponse.json({ error: "That username doesn't map to a Top Shot wallet we can deliver to.", code: "bad_request" }, { status: 400, headers: NO_STORE })
    }
    const { outcome, pack_no } = await claimPack(supabaseAdmin, drop.id, user.id, resolved.username, recipient)
    return claimOutcomeResponse(outcome, pack_no)
  } catch (err) {
    return apiErrorResponse(err, "api/giveaways/[slug] POST", "We couldn't record your claim. Try again in a moment.")
  }
}

/**
 * Claim with a connected Flow Wallet: the pack goes to that wallet or an account
 * it has linked. The wallet is the one the account proof PROVES — a bare
 * `wallet` field (an unproven address) is refused.
 */
async function claimWithWallet(req: NextRequest, slug: string, userId: string, body: { proof?: unknown; destination?: unknown }) {
  const destination = typeof body.destination === "string" ? body.destination.trim().toLowerCase() : ""
  if (body.proof === undefined) {
    return NextResponse.json(
      { error: "Connect Flow Wallet again and approve the sign-in, so we know it's yours.", code: "proof_missing" },
      { status: 400, headers: NO_STORE },
    )
  }
  if (!FLOW_ADDRESS.test(destination)) {
    return NextResponse.json({ error: "Choose where your pack should go.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  try {
    const drop = await getDrop(supabaseAdmin, { slug })
    if (!drop || drop.status === "draft") {
      return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
    }
    if (drop.status !== "open") return claimOutcomeResponse("not_open", null)

    const proven = await provenWallet(req, userId, body.proof)
    if ("res" in proven) return proven.res
    const wallet = proven.wallet
    let accounts
    try {
      accounts = await discoverAccounts(wallet)
    } catch {
      return chainUnavailable()
    }
    const target = accounts.find((a) => a.address === destination)
    if (!target) {
      return NextResponse.json(
        { error: "That account isn't your Flow Wallet or an account linked to it.", code: "not_linked" },
        { status: 400, headers: NO_STORE },
      )
    }
    if (target.topshot_count == null) {
      return NextResponse.json(
        {
          error: "That account can't receive Top Shot moments yet. Enable Top Shot in Flow Wallet, or choose your linked Dapper account.",
          code: "cannot_receive",
        },
        { status: 400, headers: NO_STORE },
      )
    }
    // the label shown on the pack and to the sponsor: the account's Top Shot username when RPC knows it
    const label = (await usernameForWallet(supabaseAdmin, destination)) ?? destination
    const { outcome, pack_no } = await claimPack(supabaseAdmin, drop.id, userId, label, destination)
    return claimOutcomeResponse(outcome, pack_no)
  } catch (err) {
    return apiErrorResponse(err, "api/giveaways/[slug] POST", "We couldn't record your claim. Try again in a moment.")
  }
}
