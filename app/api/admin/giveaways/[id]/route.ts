// app/api/admin/giveaways/[id]/route.ts
//
// Trevor-only (RPC_ADMIN_TOKEN). One drop.
//   GET  -> { drop, pool, claims }   everything, including the pack assignment (the delivery checklist)
//   POST { action: "seal" | "open" | "close" | "verify" | "delete" }
//        seal   — on-chain re-check (held + unlocked), shuffle, commit (draft only)
//        open   — sealed -> open (claims start)
//        close  — open -> closed (claims stop; salt + manifest become public)
//        verify — read the chain for every claimed moment and record delivery
//        delete — a draft only
//        deliver_plan { parent } — plan a one-signature delivery for the admin's
//               connected Flow Wallet (a Hybrid Custody parent of admin_wallet);
//               every batch is SIMULATED on mainnet first (lib/giveaways/deliver.ts).
//               RPC signs nothing: the admin's wallet signs in the browser.
// RPC never moves a moment or holds a key.

import { NextRequest, NextResponse } from "next/server"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { apiErrorResponse } from "@/lib/api-error"
import { supabaseAdmin } from "@/lib/supabase"
import {
  deleteDraft,
  getClaims,
  getDrop,
  getPool,
  GiveawayError,
  sealDrop,
  setStatus,
  verifyDeliveries,
} from "@/lib/giveaways/store"
import { planDelivery } from "@/lib/giveaways/deliver"
import { FlowScriptError } from "@/lib/giveaways/flow-script"

export const dynamic = "force-dynamic"
// seal/verify make Flow script calls (20 s bound each, 50 moments per call)
export const maxDuration = 120

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type Ctx = { params: Promise<{ id: string }> }

export async function GET(req: NextRequest, ctx: Ctx) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  const { id } = await ctx.params
  if (!UUID.test(id)) return NextResponse.json({ error: "not a drop id" }, { status: 400 })
  try {
    const drop = await getDrop(supabaseAdmin, { id })
    if (!drop) return NextResponse.json({ error: "no such drop" }, { status: 404 })
    const [pool, claims] = await Promise.all([getPool(supabaseAdmin, id), getClaims(supabaseAdmin, id)])
    return NextResponse.json({ drop, pool, claims }, { headers: { "Cache-Control": "no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/admin/giveaways/[id] GET")
  }
}

export async function POST(req: NextRequest, ctx: Ctx) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()
  const { id } = await ctx.params
  if (!UUID.test(id)) return NextResponse.json({ error: "not a drop id" }, { status: 400 })
  let action: unknown
  let parent: unknown
  try {
    const body = (await req.json()) as { action?: unknown; parent?: unknown }
    action = body?.action
    parent = body?.parent
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 })
  }
  if (
    action !== "seal" &&
    action !== "open" &&
    action !== "close" &&
    action !== "verify" &&
    action !== "delete" &&
    action !== "deliver_plan"
  ) {
    return NextResponse.json({ error: "action must be seal, open, close, verify, delete or deliver_plan" }, { status: 400 })
  }
  try {
    const drop = await getDrop(supabaseAdmin, { id })
    if (!drop) return NextResponse.json({ error: "no such drop" }, { status: 404 })
    switch (action) {
      case "seal": {
        const { hash, check } = await sealDrop(supabaseAdmin, drop)
        return NextResponse.json({ ok: true, seal_hash: hash, pool_fmv_usd: check.pool_fmv_usd })
      }
      case "open":
        await setStatus(supabaseAdmin, drop, "open")
        return NextResponse.json({ ok: true })
      case "close":
        await setStatus(supabaseAdmin, drop, "closed")
        return NextResponse.json({ ok: true })
      case "delete":
        await deleteDraft(supabaseAdmin, drop)
        return NextResponse.json({ ok: true })
      case "deliver_plan": {
        const p = typeof parent === "string" ? parent.trim().toLowerCase() : ""
        return NextResponse.json({ ok: true, plan: await planDelivery(supabaseAdmin, drop, p) })
      }
      case "verify": {
        const report = await verifyDeliveries(supabaseAdmin, drop)
        // ok only when every claimed moment was read AND every result was written.
        const ok = report.failed_recipients.length === 0 && report.write_error == null && report.written === report.checked
        return NextResponse.json({ ok, report }, { status: ok ? 200 : 207 })
      }
    }
  } catch (err) {
    if (err instanceof GiveawayError) return NextResponse.json({ error: err.message, code: err.code }, { status: err.status })
    // a Cadence panic from OUR scripts (e.g. "Cannot withdraw: Moment is locked") — operator-facing, token-gated
    if (err instanceof FlowScriptError) return NextResponse.json({ error: err.message, code: "flow" }, { status: 409 })
    return apiErrorResponse(err, `api/admin/giveaways/[id] ${String(action)}`)
  }
}
