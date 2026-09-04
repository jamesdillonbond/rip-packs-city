// app/api/teams/route.ts
//
// Reference-data endpoint for populating per-league team dropdowns on the
// edit-profile page. Backed by the `get_teams_for_league(p_league)` RPC,
// which projects `teams_master` plus a `has_moments` flag computed against
// the editions catalog. Cached an hour because the master list is updated
// infrequently and the payload is keyed only on `?league=`.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { isLeague, type TeamMaster } from "@/lib/teams";
import { apiErrorResponse } from "@/lib/api-error";
import { boundedRead } from "@/lib/api/bounded-read";

export async function GET(req: NextRequest) {
  const league = req.nextUrl.searchParams.get("league");
  if (!isLeague(league)) {
    return NextResponse.json(
      { error: "league must be one of NBA, WNBA, NFL, LALIGA" },
      { status: 400 }
    );
  }

  const { data, error } = await boundedRead((supabase as any).rpc("get_teams_for_league", {
    p_league: league,
  }), "api/teams/get_teams_for_league");

  if (error) {
    console.error("[api/teams GET]", error);
    return apiErrorResponse(error, "api/teams");
  }

  const teams = (data ?? []) as TeamMaster[];
  return NextResponse.json(
    { teams },
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
