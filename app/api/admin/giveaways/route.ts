// app/api/admin/giveaways/route.ts
//
// Trevor-only (RPC_ADMIN_TOKEN). Community pack giveaways, v1.
//   GET                      -> { drops }            every drop, newest first
//   GET ?candidates=<wallet> -> CheckedCandidates    that wallet's giftable Top Shot moments (cache, then re-checked on chain)
//   POST {draft fields}      -> { id }               create a draft (create_giveaway_draft)
// Background: docs/strategy/free-packs-reassessment-2026-09-29.md §8.

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { createDraft, GiveawayError, listCheckedCandidates, listDrops } from "@/lib/giveaways/store"
import { FLOW_WALLET, parseDraftBody } from "@/lib/giveaways/draft-input"

export const dynamic = "force-dynamic"
// the candidate list makes Flow script calls (20 s bound each)
export const maxDuration = 60

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  const wallet = req.nextUrl.searchParams.get("candidates")
  try {
    if (wallet != null) {
      const w = wallet.trim().toLowerCase()
      if (!FLOW_WALLET.test(w)) return NextResponse.json({ error: "candidates must be a Flow 0x address" }, { status: 400 })
      // re-checked on chain: the cache's lock flag has been measured stale
      return NextResponse.json(await listCheckedCandidates(supabaseAdmin, w), { headers: { "Cache-Control": "no-store" } })
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
