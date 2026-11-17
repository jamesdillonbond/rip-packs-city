// app/api/admin/allow-list/[id]/route.ts
// PATCH — admin decision on a single allow_list row. Bearer-auth-gated.
//
// Body: { action: 'approve' | 'hold' | 'deny' | 'reset', reason?: string }
// Maps to the allow_list_decide RPC's p_decision argument verbatim.
// approve  → status active, prewarm_status pending (if wallet/username on row)
// hold     → status hold, hold_reason = reason
// deny     → status rejected, reject_reason = reason, prewarm_status skipped
// reset    → status pending (clears hold/reject reasons)
//
// After mutation the route re-reads the row and returns it so the client can
// update its local state without a full refetch.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

const VALID_ACTIONS = new Set(["approve", "hold", "deny", "reset"])

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const SELECT_COLUMNS = [
  "id",
  "email",
  "wallet_addr",
  "username",
  "collections",
  "status",
  "prewarm_status",
  "prewarm_attempts",
  "prewarm_started_at",
  "prewarm_completed_at",
  "prewarm_error",
  "prewarm_summary",
  "source",
  "created_at",
  "approved_at",
  "approved_by",
  "welcome_email_sent_at",
  "welcome_email_error",
  "hold_reason",
  "reject_reason",
  "notified_at",
  "notes",
].join(",")

interface PatchBody {
  action?: string
  reason?: string | null
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()

  const { id } = await ctx.params
  if (!id || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 })
  }

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const action = typeof body.action === "string" ? body.action.trim() : ""
  if (!VALID_ACTIONS.has(action)) {
    return NextResponse.json(
      { error: `action must be one of: ${Array.from(VALID_ACTIONS).join(", ")}` },
      { status: 400 }
    )
  }

  const reason =
    typeof body.reason === "string" && body.reason.trim().length > 0
      ? body.reason.trim()
      : null

  const { data: rpcResult, error: rpcErr } = await supabaseAdmin.rpc("allow_list_decide", {
    p_id: id,
    p_decision: action,
    p_actor: "trevor",
    p_reason: reason,
  })

  if (rpcErr) {
    return NextResponse.json({ error: rpcErr.message }, { status: 500 })
  }

  const result = (rpcResult ?? {}) as { ok?: boolean; error?: string }
  if (result.ok === false) {
    const status = result.error === "not_found" ? 404 : 400
    return NextResponse.json({ error: result.error ?? "decision_rejected" }, { status })
  }

  const { data: row, error: rowErr } = await supabaseAdmin
    .from("allow_list")
    .select(SELECT_COLUMNS)
    .eq("id", id)
    .maybeSingle()

  if (rowErr) {
    return NextResponse.json({ error: rowErr.message }, { status: 500 })
  }
  if (!row) {
    return NextResponse.json({ error: "Row not found after decision" }, { status: 404 })
  }

  return NextResponse.json({ row })
}
