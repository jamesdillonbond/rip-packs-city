// app/api/giveaways/[slug]/route.ts
//
// Public giveaway drop.
//   GET  -> PublicDropView (lib/giveaways/store.ts). Anyone may read a sealed,
//           open or closed drop; a draft is a 404. When signed in, `me` carries
//           the viewer's own pack. `signed_in` says which case `me: null` is.
//   GET  ?accounts_for=<0x>  -> { accounts } where a winner who connected Flow
//           Wallet can have their pack sent: that wallet and every account it
//           has linked (Hybrid Custody, redeemed, read on chain), each with
//           whether it can receive Top Shot moments. Signed in only.
//   POST { username, agree: true } -> claim one pack (signed in; any account —
//           claims do not need allow-list approval, see proxy.ts).
//   POST { wallet, destination, agree: true } -> claim with Flow Wallet
//           (Trevor, 2026-10-03): `destination` must be `wallet` or an account it
//           has linked, and must have a Top Shot collection — verified on chain.
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

export async function GET(req: NextRequest, ctx: Ctx) {
  const { slug } = await ctx.params
  if (!SLUG.test(slug)) return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
  const accountsFor = req.nextUrl.searchParams.get("accounts_for")
  if (accountsFor != null) {
    const user = await getCurrentUser()
    if (!user) return NextResponse.json({ error: "Sign in to claim a pack.", code: "sign_in" }, { status: 401, headers: NO_STORE })
    const wallet = accountsFor.trim().toLowerCase()
    if (!FLOW_ADDRESS.test(wallet)) return NextResponse.json({ error: "That isn't a Flow wallet address.", code: "bad_request" }, { status: 400, headers: NO_STORE })
    try {
      const accounts = (await discoverAccounts(wallet)).map((a) => ({ address: a.address, role: a.role, can_receive: a.topshot_count != null }))
      return NextResponse.json({ accounts }, { headers: NO_STORE })
    } catch {
      return chainUnavailable()
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

  let body: { username?: unknown; agree?: unknown; wallet?: unknown; destination?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Enter your Top Shot username.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  if (body?.agree !== true) {
    return NextResponse.json({ error: "Confirm you are 18 or older and agree to the official rules.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  if (body.wallet !== undefined) return claimWithWallet(slug, user.id, body)
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

/** Claim with a connected Flow Wallet: the pack goes to that wallet or an account it has linked. */
async function claimWithWallet(slug: string, userId: string, body: { wallet?: unknown; destination?: unknown }) {
  const wallet = typeof body.wallet === "string" ? body.wallet.trim().toLowerCase() : ""
  const destination = typeof body.destination === "string" ? body.destination.trim().toLowerCase() : ""
  if (!FLOW_ADDRESS.test(wallet) || !FLOW_ADDRESS.test(destination)) {
    return NextResponse.json({ error: "Connect your Flow Wallet and choose where your pack should go.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  try {
    const drop = await getDrop(supabaseAdmin, { slug })
    if (!drop || drop.status === "draft") {
      return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
    }
    if (drop.status !== "open") return claimOutcomeResponse("not_open", null)

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
