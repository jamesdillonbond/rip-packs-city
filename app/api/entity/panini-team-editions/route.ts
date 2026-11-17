// app/api/entity/panini-team-editions/route.ts
// Backs the Panini panel's "Load more" on a franchise hub (/teams/<league>/<slug>,
// 2026-10-22) via get_panini_franchise_editions — Panini cards matched to the
// franchise by the team walk (panini_team_listings), same tile shape as
// /api/entity/team-editions.
//   GET /api/entity/panini-team-editions?league=<NBA>&team=<blazers>&offset=N&limit=N

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { isLeague } from "@/lib/teams"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const league = (url.searchParams.get("league") ?? "").toUpperCase()
  const team = (url.searchParams.get("team") ?? "").toLowerCase()
  if (!isLeague(league)) return NextResponse.json({ error: "unknown league" }, { status: 404 })
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team)) return NextResponse.json({ error: "missing team" }, { status: 400 })

  const offset = clamp(parseInt(url.searchParams.get("offset") ?? "0", 10), 0, 50_000)
  const limit = clamp(parseInt(url.searchParams.get("limit") ?? "24", 10), 1, 100)

  const supa = supabaseAdmin as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }> }
  const { data, error } = await boundedRead(supa.rpc("get_panini_franchise_editions", {
    p_league: league,
    p_team_slug: team,
    p_limit: limit,
    p_offset: offset,
  }), "api/entity/panini-team-editions/get_panini_franchise_editions")
  if (error) return apiErrorResponse(error, "api/entity/panini-team-editions")
  return NextResponse.json(data ?? [])
}

function clamp(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}
