// lib/fan-teams/followed-players.ts
//
// The players a signed-in user follows (2026-10-31; webz_80's request, feedback
// 11800), for /my-teams. Read through the user's SESSION client — RLS
// (ufp_select_own) is the ownership check. `ok:false` is a FAILED read: the page
// must not then tell a follower they follow nobody.

import { withBoardBudget } from "@/lib/insights/board-page-fetch"

export interface FollowedPlayer {
  slug: string
  name: string
  /** null = a cross-collection hub follow; else the collection whose player page was followed */
  collection: string | null
}

interface SessionLike {
  from: (table: string) => {
    select: (cols: string) => {
      order: (col: string, opts: { ascending: boolean }) => {
        order: (col: string, opts: { ascending: boolean }) => {
          limit: (n: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>
        }
      }
    }
  }
}

export async function fetchFollowedPlayers(session: unknown): Promise<{ players: FollowedPlayer[]; ok: boolean }> {
  try {
    // Bounded: a hung read reaches the page's "couldn't be loaded" branch instead of hanging /my-teams.
    const { data, error } = await withBoardBudget(
      Promise.resolve(
        (session as SessionLike)
          .from("user_favorite_players")
          .select("player_slug, display_name, collection_slug")
          .order("created_at", { ascending: true })
          .order("player_slug", { ascending: true })
          .limit(50),
      ),
      "followed-players",
      8000,
      "my-teams/",
    )
    if (error) {
      console.error("[my-teams] followed players read failed:", error.message)
      return { players: [], ok: false }
    }
    const rows = Array.isArray(data) ? (data as Array<{ player_slug?: unknown; display_name?: unknown; collection_slug?: unknown }>) : []
    const players = rows
      .filter((r) => typeof r.player_slug === "string" && typeof r.display_name === "string")
      .map((r) => ({
        slug: r.player_slug as string,
        name: r.display_name as string,
        collection: typeof r.collection_slug === "string" && r.collection_slug ? r.collection_slug : null,
      }))
    return { players, ok: true }
  } catch (e) {
    console.error("[my-teams] followed players read threw:", e instanceof Error ? e.message : String(e))
    return { players: [], ok: false }
  }
}
