// lib/panini/player-teams.ts
//
// The franchises a Panini player's cards sit on (2026-10-26) — get_panini_player_teams, which reads the
// team map (panini_edition_team_keys) over the player's SINGLE-player cards, most cards first. Top Shot's
// player page names the player's team; Panini cards carry no team field, so this is how a Panini player
// page can. A failed read returns ok:false and renders nothing — never "no team".

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export interface PaniniPlayerTeam {
  league: string
  slug: string
  teamName: string
  editions: number
}

/** Shown on the page; a longer career list is cut, never padded. */
export const PANINI_PLAYER_TEAMS_SHOWN = 4

export function toPlayerTeams(raw: unknown): PaniniPlayerTeam[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((r) => (r && typeof r === "object" ? (r as Record<string, unknown>) : null))
    .filter((r): r is Record<string, unknown> => !!r && typeof r.league === "string" && typeof r.slug === "string" && typeof r.team_name === "string")
    .map((r) => ({ league: r.league as string, slug: r.slug as string, teamName: r.team_name as string, editions: Number(r.editions) || 0 }))
}

export async function fetchPaniniPlayerTeams(name: string, db: Db = supabaseAdmin): Promise<{ ok: boolean; teams: PaniniPlayerTeam[] }> {
  if (!name || !name.trim()) return { ok: true, teams: [] }
  try {
    const { data, error } = await withQueryDeadline<unknown>(
      db.rpc("get_panini_player_teams", { p_name: name }),
      "player/panini-teams",
      apiReadTimeoutMs(),
    )
    if (error) return { ok: false, teams: [] }
    return { ok: true, teams: toPlayerTeams(data) }
  } catch {
    return { ok: false, teams: [] }
  }
}
