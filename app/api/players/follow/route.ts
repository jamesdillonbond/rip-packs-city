// app/api/players/follow/route.ts
//
// Follow a player (2026-10-31; webz_80's 10-27 concierge request, feedback 11800:
// "favorite player option similar to favorite team"). Teams are one pick per league;
// players are a LIST (max 50, DB trigger), keyed by the collection-agnostic player hub
// slug, so one follow covers a player's Top Shot Moments and Panini cards alike.
//
// SECURITY: same shape as /api/teams/follow — the authenticated user's SESSION client,
// so the user_favorite_players RLS policies (auth.uid() = user_id) are the ownership
// check. No anon write path; the hub read that validates a slug uses the public RPC.
//
//   GET                -> { authed, players: [{ slug, name, followed_at }] }
//   GET    ?slug=x     -> { authed, following }
//   POST   { slug }    -> follow (the slug must resolve to a player hub; stores it + the hub name)
//   DELETE ?slug=x     -> unfollow

import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServer } from "@/lib/auth/supabase-server"
import { apiErrorResponse } from "@/lib/api-error"
import { fetchPlayerHub, parsePlayerHubSlug } from "@/lib/player-hub"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"

// Every read/write is bounded: a hung query reaches the honest error branch, not a 504.
const bound = <T,>(p: PromiseLike<T>, label: string): Promise<T> => withBoardBudget(Promise.resolve(p), label, 8000, "api/players-follow/")

export const dynamic = "force-dynamic"

const MAX_FOLLOWED_PLAYERS = 50

type Row = { player_slug: string; display_name: string; created_at: string }

export async function GET(req: NextRequest) {
  const rawSlug = req.nextUrl.searchParams.get("slug")
  const slug = rawSlug == null ? null : parsePlayerHubSlug(rawSlug)
  if (rawSlug != null && !slug) return NextResponse.json({ authed: false, following: false })

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json(slug ? { authed: false, following: false } : { authed: false, players: [] })

  if (slug) {
    // A failed read is not "not following" (same rule as the team button).
    let res: { data: unknown; error: { message: string } | null }
    try {
      res = await bound(supabase.from("user_favorite_players").select("player_slug").eq("user_id", user.id).eq("player_slug", slug).maybeSingle(), "status")
    } catch (e) {
      return apiErrorResponse(e, "api/players/follow")
    }
    const { data, error } = res
    if (error) return apiErrorResponse(error, "api/players/follow")
    return NextResponse.json({ authed: true, following: data != null })
  }

  let list: { data: unknown; error: { message: string } | null }
  try {
    list = await bound(
      supabase.from("user_favorite_players").select("player_slug, display_name, created_at").eq("user_id", user.id)
        .order("created_at", { ascending: true }).order("player_slug", { ascending: true }).limit(MAX_FOLLOWED_PLAYERS),
      "list",
    )
  } catch (e) {
    return apiErrorResponse(e, "api/players/follow")
  }
  const { data, error } = list
  if (error) return apiErrorResponse(error, "api/players/follow")
  const players = ((data ?? []) as Row[]).map((r) => ({ slug: r.player_slug, name: r.display_name, followed_at: r.created_at }))
  return NextResponse.json({ authed: true, players })
}

export async function POST(req: NextRequest) {
  let body: { slug?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const slug = typeof body.slug === "string" ? parsePlayerHubSlug(body.slug) : null
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 })

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  // Only a slug that names a player hub can be followed. A failed hub read is a 503,
  // never a follow of an unverified slug and never a "no such player".
  const { hub, ok } = await fetchPlayerHub(slug)
  if (!ok) return NextResponse.json({ error: "Player lookup is unavailable right now." }, { status: 503 })
  if (!hub) return NextResponse.json({ error: "unknown player" }, { status: 404 })
  // Stored under the slug the page asked with (not the hub's canonical one), so the same
  // page's status read finds it; /players/<slug> folds aliases on the way in.

  const { error } = await supabase
    .from("user_favorite_players")
    .upsert({ user_id: user.id, player_slug: slug, display_name: String(hub.name).slice(0, 200) }, { onConflict: "user_id,player_slug", ignoreDuplicates: true })
  if (error) {
    // The 50-player trigger raises check_violation (23514).
    if ((error as { code?: string }).code === "23514") {
      return NextResponse.json({ error: `You can follow up to ${MAX_FOLLOWED_PLAYERS} players.` }, { status: 409 })
    }
    console.log("[players/follow] upsert failed:", error.message)
    return apiErrorResponse(error, "api/players/follow")
  }
  return NextResponse.json({ ok: true, following: true, slug, name: hub.name })
}

export async function DELETE(req: NextRequest) {
  const slug = parsePlayerHubSlug(req.nextUrl.searchParams.get("slug") ?? "")
  if (!slug) return NextResponse.json({ error: "invalid slug" }, { status: 400 })

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  const { error } = await supabase
    .from("user_favorite_players")
    .delete()
    .eq("user_id", user.id)
    .eq("player_slug", slug)
  if (error) {
    console.log("[players/follow] delete failed:", error.message)
    return apiErrorResponse(error, "api/players/follow")
  }
  return NextResponse.json({ ok: true, following: false })
}
