// app/api/insider-signals/route.ts
//
// Returns non-expired topshot_insider_alerts ordered by severity desc, then
// generated_at desc. Auth-gated via Supabase cookie session; access is
// uniform to the alert pool (no per-user filtering).

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

export async function GET() {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  const nowIso = new Date().toISOString()
  const { data, error } = await (supabaseAdmin as any)
    .from("topshot_insider_alerts")
    .select("id, alert_type, title, summary, evidence_jsonb, severity, generated_at, expires_at")
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`)
    .order("severity", { ascending: false })
    .order("generated_at", { ascending: false })
    .limit(50)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true, alerts: data ?? [] })
}
