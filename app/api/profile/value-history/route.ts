// app/api/profile/value-history/route.ts
//
// GET /api/profile/value-history — the signed-in member's daily portfolio snapshots
// (last 30 days): moments FMV (total_fmv) and, beside it, sealed packs at the capped
// lowest live ask (pack_low_ask_usd, recorded from 2026-11-22). Backs the /dashboard
// "Value / 30D" card (Trevor, 2026-11-22: "Both").
//
// Auth: Supabase session. Snapshots are keyed by auth user id (owner_key), so the
// caller can only ever read their own rows — no client-supplied key.
// A NULL pack value is "not measured", never 0; the client draws no point for it.

import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

export async function GET() {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }
  try {
    const { data, error } = await boundedRead(sb
      .from("portfolio_snapshots")
      .select("snapshot_date, total_fmv, moment_count, pack_low_ask_usd, pack_held_count")
      .eq("owner_key", user.id)
      .order("snapshot_date", { ascending: false })
      .limit(30), "api/profile/value-history/portfolio_snapshots")
    if (error) return apiErrorResponse(error, "api/profile/value-history")
    const rows = (Array.isArray(data) ? data : []) as Array<{
      snapshot_date: string; total_fmv: number | string | null; moment_count: number | null
      pack_low_ask_usd: number | string | null; pack_held_count: number | null
    }>
    const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
    const history = rows.reverse().map((r) => ({
      date: r.snapshot_date,
      moments_usd: n(r.total_fmv),
      packs_usd: n(r.pack_low_ask_usd),
      packs_held: n(r.pack_held_count),
    }))
    return NextResponse.json({ history }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/profile/value-history")
  }
}
