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
import { awardPoints } from "@/lib/rewards";
import { requireUser } from "@/lib/auth/supabase-server";
import { apiErrorResponse } from "@/lib/api-error";

// ⚠ HONESTY CANON. This resolver DID look at its `error` and log it — and then
// collapsed the failure onto `null`, which the GET below spells `{ teams: [] }`.
// CLAUDE.md names that exact rendering as an instance of the class: *"Follow a
// team to build your hub" to someone who follows six.* Catching an error is not
// the same as reporting it; the three states (read failed · no such owner ·
// owner with no teams) had two spellings between them.
//
// ⚠ The POST leg's `null` was SAFE — it fails closed to a 404 before the
// `resolvedId !== sessionUser.id` ownership check — so this change makes its
// copy honest without changing what it permits. Stated because "fix every
// caller" and "every caller was equally broken" are different claims.
type OwnerResolution =
  | { ok: true; userId: string | null }
  | { ok: false; error: unknown };

async function resolveUserId(ownerKey: string): Promise<OwnerResolution> {
  const { data, error } = await supabase
    .from("profile_bio")
    .select("user_id")
    .ilike("username", ownerKey)
    .maybeSingle();
  if (error) {
    console.error("[profile/teams resolveUserId]", error);
    return { ok: false, error };
  }
  return { ok: true, userId: (data as any)?.user_id ?? null };
}

export async function GET(req: NextRequest) {
  const ownerKey = (req.nextUrl.searchParams.get("ownerKey") ?? "").trim();
  if (!ownerKey) {
    return NextResponse.json({ error: "ownerKey required" }, { status: 400 });
  }

  const owner = await resolveUserId(ownerKey);
  if (!owner.ok) {
    return apiErrorResponse(owner.error, "api/profile/teams");
  }
  if (!owner.userId) {
    return NextResponse.json({ teams: [] });
  }
  const userId = owner.userId;

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
    return apiErrorResponse(error, "api/profile/teams");
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
  // SECURITY: self-service editor — the write target MUST come from the
  // authenticated session, never the body. This previously resolved the
  // body `ownerKey` (a PUBLIC username) to a user_id and replace-all-wrote
  // that user's teams via the service-role client, letting any signed-in
  // user overwrite anyone's favorite teams (IDOR).
  let sessionUser;
  try {
    sessionUser = await requireUser();
  } catch (res) {
    return res as Response;
  }

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

  // ownerKey is retained for backward compat with the client, but it MUST
  // resolve to the caller — reject any attempt to write another user's set.
  // ⚠ This leg already failed CLOSED on a swallowed error (null → 404, before
  // the ownership check below), so the fix here is honesty, not authorization:
  // a read failure stops being reported as "user not found". The 403 branch is
  // untouched and still the only thing that permits the write.
  const resolved = await resolveUserId(ownerKey);
  if (!resolved.ok) {
    return apiErrorResponse(resolved.error, "api/profile/teams");
  }
  const resolvedId = resolved.userId;
  if (!resolvedId) {
    return NextResponse.json({ error: "user not found" }, { status: 404 });
  }
  if (resolvedId !== sessionUser.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const userId = sessionUser.id;

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
    return apiErrorResponse(delErr, "api/profile/teams");
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
      return apiErrorResponse(insErr, "api/profile/teams");
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
    return apiErrorResponse(error, "api/profile/teams");
  }

  const saved: UserFavoriteTeam[] = (data ?? []).map((row: any) => ({
    league: row.league,
    team_slug: row.team_slug,
    team_name: row.teams_master?.team_name ?? row.team_slug,
    abbreviation: row.teams_master?.abbreviation ?? "",
    primary_color: row.teams_master?.primary_color ?? "#E03A2F",
    is_primary: !!row.is_primary,
  }));

  // Rewards: picking a favorite team earns set_favorite_team (per_user_limit=1).
  // Only when the save actually leaves the user with at least one team. userId
  // is the resolved profile owner; the rule's per-user cap bounds any abuse.
  if (saved.length > 0) {
    await awardPoints(userId, "set_favorite_team");
  }

  return NextResponse.json({ teams: saved });
}
