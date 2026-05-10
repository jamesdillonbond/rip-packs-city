// app/api/admin/resend-welcome/route.ts
//
// Admin one-shot: re-fire the welcome email for a dormant allow_list row.
// Resets welcome_email_sent_at + prewarm_status to NULL so the row re-enters
// the next prewarm cron drain (or immediately if force=true via inline
// processSinglePrewarmRow).
//
// Bearer-auth-gated against RPC_ADMIN_TOKEN. Body: { email: string, force?: boolean }.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"
import { processSinglePrewarmRow, type AllowListRow } from "@/lib/allow-list/prewarm"

export const dynamic = "force-dynamic"
export const maxDuration = 300

interface PostBody {
  email?: string
  force?: boolean
}

export async function POST(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()

  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : ""
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "email required" }, { status: 400 })
  }

  const { data: row, error: fetchErr } = await supabaseAdmin
    .from("allow_list")
    .select("id, email, wallet_addr, username, collections, status, prewarm_status, prewarm_attempts, welcome_email_sent_at")
    .ilike("email", email)
    .maybeSingle()
  if (fetchErr) {
    return NextResponse.json({ error: fetchErr.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "no allow_list row for that email" }, { status: 404 })
  }
  if ((row as any).status !== "active") {
    return NextResponse.json(
      { error: `Row status is '${(row as any).status}' — only active rows can be re-welcomed` },
      { status: 400 }
    )
  }

  // Reset the prewarm + welcome stamps so the cron drain re-runs (or so
  // the inline run below sees the row as resend-eligible).
  const { error: resetErr } = await supabaseAdmin
    .from("allow_list")
    .update({
      welcome_email_sent_at: null,
      welcome_email_error: null,
      prewarm_status: "pending",
      prewarm_started_at: null,
      prewarm_completed_at: null,
      prewarm_error: null,
    })
    .eq("id", (row as any).id)
  if (resetErr) {
    return NextResponse.json({ error: resetErr.message }, { status: 500 })
  }

  if (!body.force) {
    return NextResponse.json({
      ok: true,
      reset: true,
      message: "Row reset; next prewarm-drain cron tick will resend the welcome email.",
      id: (row as any).id,
    })
  }

  // force=true: stamp in_progress and run the prewarm inline, mirroring
  // prewarm-now's flow.
  const { data: stamped, error: stampErr } = await supabaseAdmin
    .from("allow_list")
    .update({
      prewarm_status: "in_progress",
      prewarm_started_at: new Date().toISOString(),
      prewarm_attempts: ((row as any).prewarm_attempts ?? 0) + 1,
    })
    .eq("id", (row as any).id)
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
    return NextResponse.json({ ok: true, outcome })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    await supabaseAdmin.rpc("allow_list_finish_prewarm", {
      p_id: (row as any).id,
      p_status: "failed",
      p_summary: null,
      p_error: `resend-welcome: ${msg}`,
    })
    return NextResponse.json({ ok: false, error: msg }, { status: 500 })
  }
}
