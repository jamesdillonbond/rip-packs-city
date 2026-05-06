// app/api/fast-break/uses/route.ts
//
// Authenticated read of the user's per-player use counters for a given run.
// Powers the "Run Progress" widget on the Fast Break page.

import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { supabaseAdmin as supabase } from "@/lib/supabase"
import { requireUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

const ROUTE_HEADERS: Record<string, string> = { "X-RPC-Route": "fast-break-uses" }

const querySchema = z.object({
  runId: z.string().uuid(),
})

export async function GET(req: NextRequest) {
  let user
  try {
    user = await requireUser()
  } catch (res) {
    return res as Response
  }

  const parsed = querySchema.safeParse({ runId: req.nextUrl.searchParams.get("runId") })
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_query", detail: parsed.error.format() },
      { status: 400, headers: ROUTE_HEADERS },
    )
  }
  const { runId } = parsed.data

  try {
    const { data: uses, error } = await supabase
      .from("fast_break_player_uses")
      .select("nba_player_id, highest_tier_owned, total_allowed, times_used, dates_used, best_moment_id, best_serial, updated_at")
      .eq("user_id", user.id)
      .eq("run_id", runId)
    if (error) {
      console.error("[fast-break-uses]", error.message)
      return NextResponse.json(
        { error: "internal_error", detail: error.message },
        { status: 500, headers: ROUTE_HEADERS },
      )
    }

    const playerIds = (uses ?? []).map(u => u.nba_player_id)
    const playerMeta = new Map<string, { full_name: string; current_team_abbr: string | null }>()
    if (playerIds.length > 0) {
      const { data: players } = await supabase
        .from("nba_players")
        .select("id, full_name, current_team_abbr")
        .in("id", playerIds)
      for (const p of players ?? []) {
        playerMeta.set(p.id, { full_name: p.full_name, current_team_abbr: p.current_team_abbr })
      }
    }

    const enriched = (uses ?? []).map(u => {
      const meta = playerMeta.get(u.nba_player_id)
      return {
        nbaPlayerId: u.nba_player_id,
        fullName: meta?.full_name ?? null,
        teamAbbr: meta?.current_team_abbr ?? null,
        highestTierOwned: u.highest_tier_owned,
        totalAllowed: Number(u.total_allowed),
        timesUsed: Number(u.times_used),
        remainingUses: Math.max(0, Number(u.total_allowed) - Number(u.times_used)),
        datesUsed: u.dates_used ?? [],
        bestMomentId: u.best_moment_id ?? null,
        bestSerial: u.best_serial ?? null,
        updatedAt: u.updated_at,
      }
    })

    return NextResponse.json({ runId, uses: enriched }, { headers: ROUTE_HEADERS })
  } catch (err: any) {
    console.error("[fast-break-uses]", err?.message ?? err)
    return NextResponse.json(
      { error: "internal_error", detail: err?.message ?? String(err) },
      { status: 500, headers: ROUTE_HEADERS },
    )
  }
}
