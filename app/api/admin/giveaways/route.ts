// app/api/admin/giveaways/route.ts
//
// Trevor-only (RPC_ADMIN_TOKEN). Community pack giveaways, v1.
//   GET                      -> { drops }            every drop, newest first
//   GET ?candidates=<wallet> -> CheckedCandidates    that wallet's giftable Top Shot moments (cache, then re-checked on chain);
//                                                     <wallet> may be a Top Shot USERNAME (resolved; `username` echoed)
//   GET ?accounts_for=<0x>   -> { parent, accounts, candidates }  the connected Flow Wallet AND every account it has
//                                                     linked (Hybrid Custody, read on chain), giftable moments from each
//   POST {draft fields}      -> { id }               create a draft (create_giveaway_draft)
// Background: docs/strategy/free-packs-reassessment-2026-09-29.md §8.

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { createDraft, GiveawayError, listCandidatesAcross, listCheckedCandidates, listDrops } from "@/lib/giveaways/store"
import { discoverAccounts } from "@/lib/giveaways/linked-accounts"
import { FlowScriptError } from "@/lib/giveaways/flow-script"
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
  const parent = req.nextUrl.searchParams.get("accounts_for")
  try {
    if (parent != null) {
      const p = parent.trim().toLowerCase()
      if (!FLOW_WALLET.test(p)) return NextResponse.json({ error: "accounts_for must be a Flow 0x address" }, { status: 400 })
      const accounts = await discoverAccounts(p)
      const across = await listCandidatesAcross(supabaseAdmin, accounts)
      return NextResponse.json({ parent: p, ...across }, { headers: { "Cache-Control": "no-store" } })
    }
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
    // our own copy, or the chain read's own message (operator-facing, token-gated)
    if (err instanceof GiveawayError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    if (err instanceof FlowScriptError) return NextResponse.json({ error: err.message, code: "flow_script" }, { status: 502 })
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
    if (input.source_wallets) {
      // every source must be the connected wallet or an account it has REDEEMED — read on chain, not trusted from the body
      const mine = new Set((await discoverAccounts(input.admin_wallet)).map((a) => a.address))
      const foreign = [...new Set(input.source_wallets)].filter((w) => !mine.has(w))
      if (foreign.length) {
        return NextResponse.json(
          { error: `Not your Flow Wallet or an account it has linked: ${foreign.join(", ")}`, code: "not_linked" },
          { status: 400 },
        )
      }
    }
    const id = await createDraft(supabaseAdmin, input)
    return NextResponse.json({ id }, { status: 201 })
  } catch (err) {
    // Our own refusal copy (the draft function's RAISE text) — operator-facing, token-gated.
    if (err instanceof GiveawayError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    if (err instanceof FlowScriptError) return NextResponse.json({ error: err.message, code: "flow_script" }, { status: 502 })
    return apiErrorResponse(err, "api/admin/giveaways POST")
  }
}
