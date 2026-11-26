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
// 2026-11-22: a stored 0 WITH packs held means none of them had a live ask — unpriced, so it is
// returned as null too. A 0 with no packs held is a true $0 and stays 0.

import { NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"
import { dayBefore, linkedPaniniUsernames, paniniValueByDay, readPaniniDays } from "@/lib/panini/linked-value"

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
      .select("snapshot_date, total_fmv, moment_count, pack_low_ask_usd, pack_held_count, pack_value_basis")
      .eq("owner_key", user.id)
      .order("snapshot_date", { ascending: false })
      .limit(30), "api/profile/value-history/portfolio_snapshots")
    if (error) return apiErrorResponse(error, "api/profile/value-history")
    const rows = (Array.isArray(data) ? data : []) as Array<{
      snapshot_date: string; total_fmv: number | string | null; moment_count: number | null
      pack_low_ask_usd: number | string | null; pack_held_count: number | null
      pack_value_basis?: string | null
    }>
    // 2026-11-25 (Trevor: Panini "should be" in Portfolio FMV): linked Panini usernames' recorded
    // value per day (panini_portfolio_daily) as a third stacked part. A failed read leaves the part
    // out (null on every night, and `cards_failed` says so) — never $0.
    const usernames = await linkedPaniniUsernames(sb, user.id, "api/profile/value-history")
    const paniniRows = usernames === null ? null : await readPaniniDays(sb, usernames, dayBefore(new Date(), 31), "api/profile/value-history")
    const cardsByDay = paniniRows === null ? null : paniniValueByDay(paniniRows)
    const n = (v: unknown) => (v == null || !Number.isFinite(Number(v)) ? null : Number(v))
    const history = rows.reverse().map((r) => ({
      date: r.snapshot_date,
      moments_usd: n(r.total_fmv),
      packs_usd: n(r.pack_low_ask_usd) === 0 && (n(r.pack_held_count) ?? 0) > 0 ? null : n(r.pack_low_ask_usd),
      packs_held: n(r.pack_held_count),
      // 2026-11-22: nights before packs were recorded live are RECONSTRUCTED from ask history
      // (backfill_portfolio_snapshot_pack_values) — an estimate, and the chart says so.
      packs_estimated: r.pack_value_basis != null,
      cards_usd: cardsByDay?.get(r.snapshot_date) ?? null,
    }))
    return NextResponse.json({ history, cards_failed: cardsByDay === null }, { headers: { "Cache-Control": "private, no-store" } })
  } catch (err) {
    return apiErrorResponse(err, "api/profile/value-history")
  }
}
