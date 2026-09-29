// app/api/giveaways/[slug]/route.ts
//
// Public giveaway drop.
//   GET  -> PublicDropView (lib/giveaways/store.ts). Anyone may read a sealed,
//           open or closed drop; a draft is a 404. When signed in, `me` carries
//           the viewer's own pack. `signed_in` says which case `me: null` is.
//   POST { username, agree: true } -> claim one pack (signed in; any account —
//           claims do not need allow-list approval, see proxy.ts).
//
// The claim resolves the Top Shot username to its Flow wallet (the delivery
// target the admin gifts to in the Top Shot app) and draws a uniformly random
// unclaimed pack in the database (claim_giveaway_pack).

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { supabaseAdmin } from "@/lib/supabase"
import { resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve"
import { buildPublicView, claimPack, getClaims, getDrop, getPool } from "@/lib/giveaways/store"
import { claimOutcomeResponse } from "@/lib/giveaways/claim-copy"

export const dynamic = "force-dynamic"

const SLUG = /^[a-z0-9][a-z0-9-]{2,59}$/
const USERNAME = /^@?[A-Za-z0-9_.-]{2,40}$/

type Ctx = { params: Promise<{ slug: string }> }

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(_req: NextRequest, ctx: Ctx) {
  const { slug } = await ctx.params
  if (!SLUG.test(slug)) return NextResponse.json({ error: "No such giveaway.", code: "not_found" }, { status: 404, headers: NO_STORE })
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

  let body: { username?: unknown; agree?: unknown }
  try {
    body = (await req.json()) as typeof body
  } catch {
    return NextResponse.json({ error: "Enter your Top Shot username.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
  if (body?.agree !== true) {
    return NextResponse.json({ error: "Confirm you are 18 or older and agree to the official rules.", code: "bad_request" }, { status: 400, headers: NO_STORE })
  }
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
