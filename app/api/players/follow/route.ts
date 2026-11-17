// app/api/players/follow/route.ts
//
// Follow a player (2026-10-31; webz_80's 10-27 concierge request, feedback 11800:
// "favorite player option similar to favorite team"). Teams are one pick per league;
// players are a LIST (max 50, DB trigger).
//
// TWO KINDS OF FOLLOW (collection_slug column):
//   ''                 a cross-collection player HUB follow (/players/<slug>) — every
//                      sports collection: Top Shot, All Day, Golazos, UFC, Candy MLB,
//                      Panini. One follow covers the person in every collection.
//   '<collection>'     a follow of ONE collection's player page — Disney Pinnacle
//                      characters (the hub excludes them), and any player page whose
//                      slug the hub does not resolve. Validated by that page's own
//                      get_player_detail read.
//
// SECURITY: same shape as /api/teams/follow — the authenticated user's SESSION client,
// so the user_favorite_players RLS policies (auth.uid() = user_id) are the ownership
// check. No anon write path; the reads that validate a slug use the public RPCs.
//
//   GET                              -> { authed, players: [{ slug, name, collection, followed_at }] }
//   GET    ?slug=x[&collection=c]    -> { authed, following }   (hub OR c-scoped row)
//   POST   { slug, collection? }     -> follow (hub when it resolves; else c-scoped when the page resolves)
//   DELETE ?slug=x[&collection=c]    -> unfollow (both kinds)

import { NextRequest, NextResponse } from "next/server"
import { getSupabaseServer } from "@/lib/auth/supabase-server"
import { apiErrorResponse } from "@/lib/api-error"
import { fetchPlayerHub, parsePlayerHubSlug } from "@/lib/player-hub"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { fetchEntityDetailRaw, firstEntityRow } from "@/lib/entity-detail-gate"

// Every read/write is bounded: a hung query reaches the honest error branch, not a 504.
const bound = <T,>(p: PromiseLike<T>, label: string): Promise<T> => withBoardBudget(Promise.resolve(p), label, 8000, "api/players-follow/")

export const dynamic = "force-dynamic"

const MAX_FOLLOWED_PLAYERS = 50
// The hub (get_player_hub) excludes Pinnacle: its characters are always page-scoped.
const NOT_HUBBED = new Set(["disney-pinnacle"])

type Row = { player_slug: string; display_name: string; collection_slug: string; created_at: string }
type Res = { data: unknown; error: { message: string } | null }

/** A URL collection slug the app knows, else null. */
function collectionParam(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null
  const c = getCollectionByUrlSlug(v.trim())
  return c ? c.urlSlug : null
}

function scopes(collection: string | null): string[] {
  return collection ? ["", collection] : [""]
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const rawSlug = sp.get("slug")
  const slug = rawSlug == null ? null : parsePlayerHubSlug(rawSlug)
  if (rawSlug != null && !slug) return NextResponse.json({ authed: false, following: false })
  const collection = collectionParam(sp.get("collection"))

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json(slug ? { authed: false, following: false } : { authed: false, players: [] })

  if (slug) {
    // A failed read is not "not following" (same rule as the team button).
    let res: Res
    try {
      res = await bound(
        supabase.from("user_favorite_players").select("player_slug").eq("user_id", user.id).eq("player_slug", slug)
          .in("collection_slug", scopes(collection)).limit(1),
        "status",
      )
    } catch (e) {
      return apiErrorResponse(e, "api/players/follow")
    }
    if (res.error) return apiErrorResponse(res.error, "api/players/follow")
    return NextResponse.json({ authed: true, following: Array.isArray(res.data) && res.data.length > 0 })
  }

  let list: Res
  try {
    list = await bound(
      supabase.from("user_favorite_players").select("player_slug, display_name, collection_slug, created_at").eq("user_id", user.id)
        .order("created_at", { ascending: true }).order("player_slug", { ascending: true }).limit(MAX_FOLLOWED_PLAYERS),
      "list",
    )
  } catch (e) {
    return apiErrorResponse(e, "api/players/follow")
  }
  if (list.error) return apiErrorResponse(list.error, "api/players/follow")
  const players = ((list.data ?? []) as Row[]).map((r) => ({
    slug: r.player_slug, name: r.display_name, collection: r.collection_slug || null, followed_at: r.created_at,
  }))
  return NextResponse.json({ authed: true, players })
}

/** The page-scoped check: does <collection>/player/<slug> resolve? null = the read FAILED. */
async function pageName(collection: string, slug: string): Promise<{ name: string | null } | null> {
  const coll = getCollectionByUrlSlug(collection)
  if (!coll) return { name: null }
  try {
    const { data, error } = await bound(fetchEntityDetailRaw("player", coll.id, slug), "page")
    if (error) return null
    const row = firstEntityRow<{ name?: unknown }>(data)
    return { name: row && typeof row.name === "string" && row.name ? row.name : null }
  } catch {
    return null
  }
}

export async function POST(req: NextRequest) {
  let body: { slug?: unknown; collection?: unknown }
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }
  const slug = typeof body.slug === "string" ? parsePlayerHubSlug(body.slug) : null
  if (!slug) return NextResponse.json({ error: "slug required" }, { status: 400 })
  const collection = collectionParam(body.collection)
  if (body.collection != null && body.collection !== "" && !collection) {
    return NextResponse.json({ error: "unknown collection" }, { status: 400 })
  }

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  // Resolve what is being followed. A FAILED read is a 503 — never a follow of an
  // unverified slug, and never "no such player".
  let scope = ""
  let name: string | null = null
  if (!collection || !NOT_HUBBED.has(collection)) {
    const { hub, ok } = await fetchPlayerHub(slug)
    if (!ok) return NextResponse.json({ error: "Player lookup is unavailable right now." }, { status: 503 })
    if (hub) name = String(hub.name)
  }
  if (!name && collection) {
    const page = await pageName(collection, slug)
    if (!page) return NextResponse.json({ error: "Player lookup is unavailable right now." }, { status: 503 })
    if (page.name) { name = page.name; scope = collection }
  }
  if (!name) return NextResponse.json({ error: "unknown player" }, { status: 404 })

  // Stored under the slug the page asked with (not the hub's canonical one), so the
  // same page's status read finds it; /players/<slug> folds aliases on the way in.
  const { error } = await supabase
    .from("user_favorite_players")
    .upsert(
      { user_id: user.id, player_slug: slug, collection_slug: scope, display_name: name.slice(0, 200) },
      { onConflict: "user_id,collection_slug,player_slug", ignoreDuplicates: true },
    )
  if (error) {
    // The 50-player trigger raises check_violation (23514).
    if ((error as { code?: string }).code === "23514") {
      return NextResponse.json({ error: `You can follow up to ${MAX_FOLLOWED_PLAYERS} players.` }, { status: 409 })
    }
    console.log("[players/follow] upsert failed:", error.message)
    return apiErrorResponse(error, "api/players/follow")
  }
  return NextResponse.json({ ok: true, following: true, slug, name, collection: scope || null })
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams
  const slug = parsePlayerHubSlug(sp.get("slug") ?? "")
  if (!slug) return NextResponse.json({ error: "invalid slug" }, { status: 400 })
  const collection = collectionParam(sp.get("collection"))

  const supabase = await getSupabaseServer()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Authentication required" }, { status: 401 })

  const { error } = await supabase
    .from("user_favorite_players")
    .delete()
    .eq("user_id", user.id)
    .eq("player_slug", slug)
    .in("collection_slug", scopes(collection))
  if (error) {
    console.log("[players/follow] delete failed:", error.message)
    return apiErrorResponse(error, "api/players/follow")
  }
  return NextResponse.json({ ok: true, following: false })
}
