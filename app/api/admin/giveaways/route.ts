// app/api/admin/giveaways/route.ts
//
// Trevor-only (RPC_ADMIN_TOKEN). Community pack giveaways, v1.
//   GET                      -> { drops }            every drop, newest first
//   GET ?candidates=<wallet> -> CheckedCandidates    that wallet's giftable Top Shot moments (cache, then re-checked on chain);
//                                                     <wallet> may be a Top Shot USERNAME (resolved; `username` echoed)
//   POST {draft fields}      -> { id }               create a draft (create_giveaway_draft)
// Background: docs/strategy/free-packs-reassessment-2026-09-29.md §8.

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { createDraft, GiveawayError, listCheckedCandidates, listDrops } from "@/lib/giveaways/store"
import { FLOW_WALLET, parseDraftBody } from "@/lib/giveaways/draft-input"
import { resolveTopShotUsernameCacheAware } from "@/lib/chains/flow/topshot-username-resolve"

// A Top Shot username, optionally @-prefixed (Trevor typed "jamesdillonbond", 2026-10-03).
const TOPSHOT_USERNAME = /^@?[A-Za-z0-9_.-]{2,40}$/

export const dynamic = "force-dynamic"
// the candidate list makes Flow script calls (20 s bound each)
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  const wallet = req.nextUrl.searchParams.get("candidates")
  try {
    if (wallet != null) {
      const raw = wallet.trim()
      let w = raw.toLowerCase()
      let username: string | null = null
      if (!FLOW_WALLET.test(w)) {
        if (!TOPSHOT_USERNAME.test(raw)) {
          return NextResponse.json({ error: "Enter a Flow 0x address or a Top Shot username." }, { status: 400 })
        }
        const r = await resolveTopShotUsernameCacheAware(supabaseAdmin, raw)
        if (!r.found) {
          // a failed LOOKUP is not an absent account: never tell the admin a username doesn't exist when Top Shot didn't answer
          if (r.reason === "topshot_gql_error") {
            return NextResponse.json({ error: "Couldn't reach Top Shot to look up that username. Try again, or paste the 0x address." }, { status: 502 })
          }
          return NextResponse.json({ error: `No Top Shot account found for "${raw.replace(/^@+/, "")}".` }, { status: 404 })
        }
        w = r.walletAddress.toLowerCase()
        username = r.username
        if (!FLOW_WALLET.test(w)) return NextResponse.json({ error: "The username resolved to an address that is not a Flow 0x address." }, { status: 502 })
      }
      // re-checked on chain: the cache's lock flag has been measured stale
      const checked = await listCheckedCandidates(supabaseAdmin, w)
      return NextResponse.json(username ? { ...checked, username } : checked, { headers: { "Cache-Control": "no-store" } })
    }
    return NextResponse.json({ drops: await listDrops(supabaseAdmin) }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/admin/giveaways GET")
  }
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 })
  }
  const input = parseDraftBody(body)
  if (typeof input === "string") return NextResponse.json({ error: input }, { status: 400 })
  try {
    const id = await createDraft(supabaseAdmin, input)
    return NextResponse.json({ id }, { status: 201 })
  } catch (err) {
    // Our own refusal copy (the draft function's RAISE text) — operator-facing, token-gated.
    if (err instanceof GiveawayError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    return apiErrorResponse(err, "api/admin/giveaways POST")
  }
}
