// app/api/admin/allow-list/route.ts
// GET — list allow_list rows for the admin triage page. Bearer-auth-gated
// against RPC_ADMIN_TOKEN.
//
// Status ordering: pending > hold > active > rejected. Within each bucket,
// most-recent-first by created_at. Postgrest doesn't expose CASE ordering, so
// we order in app code after the fetch.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { verifyAdminRequest, adminUnauthorizedResponse } from "@/lib/admin-auth"

export const dynamic = "force-dynamic"

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

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  hold: 1,
  active: 2,
  rejected: 3,
}

export async function GET(req: NextRequest) {
  if (!verifyAdminRequest(req)) return adminUnauthorizedResponse()

  const { data, error } = await supabaseAdmin
    .from("allow_list")
    .select(SELECT_COLUMNS)
    .order("created_at", { ascending: false })
    .limit(500)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const rows = (data ?? []).slice().sort((a: any, b: any) => {
    const ra = STATUS_RANK[a.status] ?? 99
    const rb = STATUS_RANK[b.status] ?? 99
    if (ra !== rb) return ra - rb
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })

  const counts: Record<string, number> = {
    pending: 0,
    hold: 0,
    active: 0,
    rejected: 0,
  }
  for (const r of rows as any[]) {
    if (counts[r.status] !== undefined) counts[r.status]++
  }

  return NextResponse.json({ rows, counts })
}
