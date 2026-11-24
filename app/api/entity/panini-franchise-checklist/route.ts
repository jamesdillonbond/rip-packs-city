// app/api/entity/panini-franchise-checklist/route.ts
//
// Panini FRANCHISE checklist (2026-11-23, Panini parity pass 2): every card the franchise hub's Panini panel lists,
// owned vs missing for a PANINI USERNAME, cost to complete by price source. Backs the checklist in the Panini panel
// of /teams/<league>/<slug> (components/panini/PaniniPlayerChecklist.tsx, kind "franchise").
//
//   GET /api/entity/panini-franchise-checklist?league=<NBA>&team=<blazers>&username=<optional>
//
// Panini has no per-collection team pages, so the shared team checklist (wallet_moments_cache) cannot serve it.
// Anon-visible GET (proxy.ts opens GET /api/entity/*); the RPC itself is service-role only.
// Three states: 404 = no mapped Panini cards for that franchise (or an unknown league) · 400 = bad input ·
// error = apiErrorResponse, never an empty checklist.

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { isLeague } from "@/lib/teams"
import { normalizePaniniUsername } from "@/lib/profile/collector-identities"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(req: Request) {
  const url = new URL(req.url)
  const league = (url.searchParams.get("league") ?? "").toUpperCase()
  const team = (url.searchParams.get("team") ?? "").toLowerCase()
  if (!isLeague(league)) return NextResponse.json({ error: "unknown league" }, { status: 404 })
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team) || team.length > 80) {
    return NextResponse.json({ error: "missing or invalid team" }, { status: 400 })
  }
  const rawUsername = (url.searchParams.get("username") ?? "").trim()
  let username: string | null = null
  if (rawUsername) {
    username = normalizePaniniUsername(rawUsername)
    if (!username) {
      return NextResponse.json(
        { error: "That doesn't look like a Panini username (2–16 letters, numbers, . _ -)." },
        { status: 400 },
      )
    }
  }

  const supa = supabaseAdmin as unknown as {
    rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { message: string } | null }>
  }
  const { data, error } = await boundedRead(
    supa.rpc("get_panini_franchise_checklist", { p_league: league, p_team_slug: team, p_username: username }),
    "api/entity/panini-franchise-checklist",
  )
  if (error) return apiErrorResponse(error, "api/entity/panini-franchise-checklist")
  if (data == null) return NextResponse.json({ error: "no Panini cards for this franchise" }, { status: 404 })
  return NextResponse.json(data, {
    headers: { "Cache-Control": username ? "private, no-store" : "public, s-maxage=300, stale-while-revalidate=600" },
  })
}
