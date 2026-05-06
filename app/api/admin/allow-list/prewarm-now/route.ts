// app/api/admin/allow-list/prewarm-now/route.ts
//
// Admin one-shot trigger: drain a single allow_list row immediately so the
// admin sees feedback in the UI without waiting for the cron drain.
//
// Bearer-auth-gated against RPC_ADMIN_TOKEN (NOT CRON_SECRET — the cron has
// its own batch route at prewarm-drain). Body: { id: uuid }.
//
// Behavior:
//   1. Fetch the row.
//   2. Refuse if status !== 'active' or prewarm_status === 'in_progress'
//      (the cron may already be working on it).
//   3. Stamp prewarm_status='in_progress', prewarm_started_at=now(),
//      prewarm_attempts++ via direct UPDATE (mirrors what
//      allow_list_claim_prewarm does in the batch path).
//   4. Run processSinglePrewarmRow synchronously and return the outcome so
//      the admin gets immediate feedback. The seeder has its own 90s timeout
//      and the route's maxDuration is 300s, leaving headroom.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { processSinglePrewarmRow, type AllowListRow } from "@/lib/allow-list/prewarm"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

interface PostBody {
  id?: string
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const id = typeof body.id === "string" ? body.id.trim() : ""
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "id must be a uuid" }, { status: 400 })
  }

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from("allow_list")
    .select("id, email, wallet_addr, username, collections, status, prewarm_status, prewarm_attempts")
    .eq("id", id)
    .maybeSingle()

  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "Row not found" }, { status: 404 })
  }
  if ((row as any).status !== "active") {
    return NextResponse.json(
      { error: `Row status is '${(row as any).status}' — only active rows can be prewarmed` },
      { status: 400 }
    )
  }
  if ((row as any).prewarm_status === "in_progress") {
    return NextResponse.json(
      { error: "Prewarm already in_progress (cron may be running it)" },
      { status: 409 }
    )
  }

  // Stamp in_progress + bump attempts (mirrors allow_list_claim_prewarm).
  const { data: stamped, error: stampErr } = await supabaseAdmin
    .from("allow_list")
    .update({
      prewarm_status: "in_progress",
      prewarm_started_at: new Date().toISOString(),
      prewarm_attempts: ((row as any).prewarm_attempts ?? 0) + 1,
    })
    .eq("id", id)
    .select("id, email, wallet_addr, username, collections, prewarm_attempts")
    .maybeSingle()

  if (stampErr) {
    return NextResponse.json({ error: stampErr.message }, { status: 500 })
  }
  if (!stamped) {
    return NextResponse.json({ error: "Row vanished mid-stamp" }, { status: 500 })
  }

  const origin = new URL(req.url).origin

  try {
    const outcome = await processSinglePrewarmRow(stamped as AllowListRow, origin)
    console.log(
      `[prewarm-now] row=${outcome.id} finish=${outcome.finish_status} welcome=${outcome.welcome_sent ? "sent" : "no"}`
    )
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[prewarm-now] row=${id} threw: ${msg}`)
    await supabaseAdmin.rpc("allow_list_finish_prewarm", {
      p_id: id,
      p_status: "failed",
      p_summary: null,
      p_error: `unhandled: ${msg}`,
    })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
