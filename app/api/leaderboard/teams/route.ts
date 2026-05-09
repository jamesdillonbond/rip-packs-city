// app/api/leaderboard/teams/route.ts
//
// Per-league fan-affinity leaderboard. Backed by the
// `get_team_fan_leaderboard(p_league)` RPC, which returns rows ranked by
// fan_count with primary_fan_count as a secondary signal. No UI consumes
// this yet — the endpoint stands alone for future leaderboard pages.
//
// Cached 5 minutes since fan affinity changes slowly and the RPC is keyed
// only on `?league=`.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { isLeague, type LeaderboardEntry } from "@/lib/teams";

export async function GET(req: NextRequest) {
  const league = req.nextUrl.searchParams.get("league");
  if (!isLeague(league)) {
    return NextResponse.json(
      { error: "league must be one of NBA, WNBA, NFL, LALIGA" },
      { status: 400 }
    );
  }

  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(
    Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1),
    100
  );

  const { data, error } = await (supabase as any).rpc("get_team_fan_leaderboard", {
    p_league: league,
  });

  if (error) {
    console.error("[leaderboard/teams GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const leaderboard = ((data ?? []) as LeaderboardEntry[]).slice(0, limit);
  return NextResponse.json(
    { league, leaderboard },
    { headers: { "Cache-Control": "public, max-age=300" } }
  );
}
