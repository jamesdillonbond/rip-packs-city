// app/api/teams/follow/route.ts
// Team Hub Phase 4 (F1). The first team-hub WRITE. Favorites are one-per-league
// (user_favorite_teams PK is (user_id, league)), so "follow" means "set this as
// my <league> team" — it replaces the user's pick for THAT league only, leaving
// other leagues' picks untouched.
//
// SECURITY: this runs through the authenticated user's Supabase SESSION client
// (anon key + the user's cookie JWT), so the user_favorite_teams RLS policies
// (auth.uid() = user_id) enforce ownership. It deliberately does NOT use the
// service-role admin client, and there is no anon write path. (The existing
// /api/profile/teams editor is a service-role + ownerKey replace-all save for
// the profile form; this is a per-action, logged-in, RLS-enforced toggle.)
//
//   GET    ?league=NBA&slug=lakers  -> { authed, following }
//   POST   { league, team_slug }    -> set as the user's <league> team
//   DELETE ?league=NBA&slug=lakers  -> unfollow (only if it is the current pick)

import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServer } from "@/lib/auth/supabase-server"
import { isLeague } from "@/lib/teams"

export const dynamic = "force-dynamic"

export async function GET(req: NextRequest) {
  const league = (req.nextUrl.searchParams.get("league") ?? "").trim()
  const slug = (req.nextUrl.searchParams.get("slug") ?? "").trim()
  if (!isLeague(league) || !slug) {
    return NextResponse.json({ authed: false, following: false })
  }
  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ authed: false, following: false })

  const { data } = await supabase
    .from("user_favorite_teams")
    .select("team_slug")
    .eq("user_id", user.id)
    .eq("league", league)
    .maybeSingle()

  return NextResponse.json({ authed: true, following: (data as { team_slug?: string } | null)?.team_slug === slug })
}

export async function POST(req: NextRequest) {
  let body: { league?: unknown; team_slug?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const league = typeof body.league === "string" ? body.league.trim() : ""
  const team_slug = typeof body.team_slug === "string" ? body.team_slug.trim() : ""
  if (!isLeague(league)) return NextResponse.json({ error: "invalid league" }, { status: 400 })
  if (!team_slug) return NextResponse.json({ error: "team_slug required" }, { status: 400 })

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  // Upsert on (user_id, league): set this team as the user's pick for the
  // league, replacing any prior pick. is_primary is omitted so PostgREST leaves
  // an existing value untouched on update and uses the column default on insert.
  // RLS (uft_insert_own WITH CHECK / uft_update_own) enforces auth.uid()=user_id;
  // the (league, team_slug) FK rejects unknown teams.
  const { error } = await supabase
    .from("user_favorite_teams")
    .upsert({ user_id: user.id, league, team_slug }, { onConflict: "user_id,league" })

  if (error) {
    console.log("[teams/follow] upsert failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, following: true })
}

export async function DELETE(req: NextRequest) {
  const league = (req.nextUrl.searchParams.get("league") ?? "").trim()
  const slug = (req.nextUrl.searchParams.get("slug") ?? "").trim()
  if (!isLeague(league) || !slug) return NextResponse.json({ error: "invalid league/slug" }, { status: 400 })

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  // Only remove the row if THIS team is the current league pick — never clobber
  // a different team's row.
  const { error } = await supabase
    .from("user_favorite_teams")
    .delete()
    .eq("user_id", user.id)
    .eq("league", league)
    .eq("team_slug", slug)

  if (error) {
    console.log("[teams/follow] delete failed:", error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, following: false })
}
