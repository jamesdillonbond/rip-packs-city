// app/api/profile/teams/route.ts
//
// GET  ?ownerKey=username — returns the user's full set of per-league team
//                           picks joined to teams_master. ownerKey is the
//                           public username; resolved through profile_bio
//                           (case-insensitive) the same way other public
//                           ownerKey-driven endpoints do.
// POST { ownerKey, teams } — replaces the user's full favorite-team set.
//                           Validates one team per league and at most one
//                           is_primary across the whole array. Save is
//                           delete-then-insert because the form is a full
//                           replacement, not a per-row edit.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin as supabase } from "@/lib/supabase";
import { isLeague, type League, type UserFavoriteTeam } from "@/lib/teams";

async function resolveUserId(ownerKey: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("profile_bio")
    .select("user_id")
    .ilike("username", ownerKey)
    .maybeSingle();
  if (error) {
    console.error("[profile/teams resolveUserId]", error);
    return null;
  }
  return (data as any)?.user_id ?? null;
}

export async function GET(req: NextRequest) {
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim();
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  const userId = await resolveUserId(ownerKey);
  if (!userId) {
    return NextResponse.json({ teams: [] });
  }

  // Inner-join teams_master so we drop any orphaned rows whose team_slug has
  // since been removed from the master catalog. Composite FK is on
  // (league, slug); PostgREST surfaces it as an embedded resource.
  const { data, error } = await supabase
    .from("user_favorite_teams")
    .select(
      "league, team_slug, is_primary, teams_master!inner(team_name, abbreviation, primary_color)"
    )
    .eq("user_id", userId)
    .order("league", { ascending: true });

  if (error) {
    console.error("[profile/teams GET]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const teams: UserFavoriteTeam[] = (data ?? []).map((row: any) => ({
    league: row.league,
    team_slug: row.team_slug,
    team_name: row.teams_master?.team_name ?? row.team_slug,
    abbreviation: row.teams_master?.abbreviation ?? "",
    primary_color: row.teams_master?.primary_color ?? "#E03A2F",
    is_primary: !!row.is_primary,
  }));

  return NextResponse.json({ teams });
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const ownerKey = typeof body?.ownerKey === "string" ? body.ownerKey.trim() : "";
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  const incoming = Array.isArray(body?.teams) ? body.teams : null;
  if (!incoming) {
    return NextResponse.json({ error: "teams must be an array" }, { status: 400 });
  }

  // Normalize + validate the incoming rows. One team per league, at most one
  // primary across the whole set, league must match the enum.
  const seenLeagues = new Set<League>();
  let primaryCount = 0;
  const rows: Array<{ league: League; team_slug: string; is_primary: boolean }> = [];
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object") {
      return NextResponse.json({ error: "team rows must be objects" }, { status: 400 });
    }
    const league = raw.league;
    const team_slug = typeof raw.team_slug === "string" ? raw.team_slug.trim() : "";
    const is_primary = !!raw.is_primary;
    if (!isLeague(league)) {
      return NextResponse.json(
        { error: `invalid league: ${String(league)}` },
        { status: 400 }
      );
    }
    if (!team_slug) continue; // empty selection = no team for that league
    if (seenLeagues.has(league)) {
      return NextResponse.json(
        { error: `duplicate league in payload: ${league}` },
        { status: 400 }
      );
    }
    seenLeagues.add(league);
    if (is_primary) primaryCount++;
    rows.push({ league, team_slug, is_primary });
  }
  if (primaryCount > 1) {
    return NextResponse.json(
      { error: "at most one team may be marked is_primary" },
      { status: 400 }
    );
  }

  const userId = await resolveUserId(ownerKey);
  if (!userId) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }

  // Replace-all semantics: delete every existing row for this user, then
  // insert the new set. The user_favorite_teams partial unique index
  // enforces "one primary per user" at the DB level too, so the in-memory
  // primaryCount check is belt-and-suspenders.
  const { error: delErr } = await supabase
    .from("user_favorite_teams")
    .delete()
    .eq("user_id", userId);
  if (delErr) {
    console.error("[profile/teams POST delete]", delErr);
    return NextResponse.json({ error: delErr.message }, { status: 500 });
  }

  if (rows.length > 0) {
    const insertRows = rows.map((r) => ({
      user_id: userId,
      league: r.league,
      team_slug: r.team_slug,
      is_primary: r.is_primary,
    }));
    const { error: insErr } = await supabase
      .from("user_favorite_teams")
      .insert(insertRows);
    if (insErr) {
      console.error("[profile/teams POST insert]", insErr);
      return NextResponse.json({ error: insErr.message }, { status: 500 });
    }
  }

  // Return the saved set in the same shape as GET so callers can drop the
  // response straight into component state.
  const { data, error } = await supabase
    .from("user_favorite_teams")
    .select(
      "league, team_slug, is_primary, teams_master!inner(team_name, abbreviation, primary_color)"
    )
    .eq("user_id", userId)
    .order("league", { ascending: true });

  if (error) {
    console.error("[profile/teams POST reselect]", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const saved: UserFavoriteTeam[] = (data ?? []).map((row: any) => ({
    league: row.league,
    team_slug: row.team_slug,
    team_name: row.teams_master?.team_name ?? row.team_slug,
    abbreviation: row.teams_master?.abbreviation ?? "",
    primary_color: row.teams_master?.primary_color ?? "#E03A2F",
    is_primary: !!row.is_primary,
  }));

  return NextResponse.json({ teams: saved });
}
