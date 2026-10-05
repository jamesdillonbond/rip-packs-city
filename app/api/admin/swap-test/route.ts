// app/api/admin/swap-test/route.ts
//
// Trevor-only (RPC_ADMIN_TOKEN). The two-signer swap test
// (docs/strategy/trading-revisit-2026-10-03.md §6; lib/swap-test/*). RPC signs
// nothing and holds nothing: it plans and simulates the swap, and relays wallet
// B's signature between two browser sessions.
//
//   POST { action: "plan", a, b }                    -> { plan }   (simulated on mainnet)
//   POST { action: "relay_post", cosigner, signable } -> { id }     (initiator, wallet A)
//   GET  ?relay=<id>                                  -> { relay }  (both sides)
//   POST { action: "relay_sign", id, signature, key_id } -> { ok }  (co-signer, wallet B)
//   POST { action: "verify", plan }                   -> { landed }  (after the seal: read the chain)

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import { FlowScriptError } from "@/lib/giveaways/flow-script"
import { planSwap, SwapTestError, verifySwap } from "@/lib/swap-test/plan"
import { getRelay, postSignable, postSignature } from "@/lib/swap-test/relay"

export const dynamic = "force-dynamic"
// planning makes several Flow script calls (20 s bound each)
export const maxDuration = 60

function failure(e: unknown, where: string): NextResponse {
  if (e instanceof SwapTestError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.status })
  if (e instanceof FlowScriptError) return NextResponse.json({ error: e.message, code: "flow_script" }, { status: 502 })
  return apiErrorResponse(e, `api/admin/swap-test ${where}`)
}

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  const id = req.nextUrl.searchParams.get("relay") ?? ""
  try {
    return NextResponse.json({ relay: await getRelay(supabaseAdmin, id, Date.now()) })
  } catch (e) {
    return failure(e, "GET")
  }
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: "Body must be JSON." }, { status: 400 })
  }
  try {
    switch (body?.action) {
      case "plan":
        return NextResponse.json({ plan: await planSwap(body.a, body.b) })
      case "verify":
        return NextResponse.json({ landed: await verifySwap(body.plan) })
      case "relay_post": {
        const cosigner = typeof body.cosigner === "string" ? body.cosigner.trim().toLowerCase() : ""
        return NextResponse.json({ id: await postSignable(supabaseAdmin, cosigner, body.signable) })
      }
      case "relay_sign":
        await postSignature(supabaseAdmin, String(body.id ?? ""), body.signature, body.key_id, Date.now())
        return NextResponse.json({ ok: true })
      default:
        return NextResponse.json({ error: "Unknown action." }, { status: 400 })
    }
  } catch (e) {
    return failure(e, "POST")
  }
}
