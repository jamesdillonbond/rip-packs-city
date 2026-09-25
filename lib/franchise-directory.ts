// lib/franchise-directory.ts
//
// The /teams index: every registered franchise, by league, each linking to its
// chain-agnostic hub (/teams/<league>/<slug>). Added 2026-09-25 — the hubs
// shipped 09-23 with links FROM each per-collection team page, but nothing
// listed them: /teams was a 404, and a collector had no way to browse "every
// team RPC covers" without first landing on one collection's team page.
//
// One read per league (get_teams_for_league — the same RPC the edit-profile
// dropdowns use), each bounded and reported on its own: a league whose read
// FAILED renders as unavailable, never as "no teams" (the three states).

import { supabaseAdmin } from "@/lib/supabase"
import { withBoardBudget } from "@/lib/insights/board-page-fetch"
import { LEAGUES, type League, type TeamMaster } from "@/lib/teams"
import type { RpcClient } from "@/lib/franchise-hub"

const LEAGUE_TIMEOUT_MS = 4_000

export type DirectoryLeague =
  | { league: League; label: string; emoji: string; state: "ok"; teams: TeamMaster[] }
  | { league: League; label: string; emoji: string; state: "failed"; teams: [] }

export interface FranchiseDirectory {
  leagues: DirectoryLeague[]
  /** How many leagues answered. 0 of N is a platform failure, not an empty catalogue. */
  okLeagues: number
}

function asTeams(data: unknown): TeamMaster[] {
  if (!Array.isArray(data)) return []
  return data.filter(
    (r): r is TeamMaster =>
      !!r && typeof r === "object" && typeof (r as TeamMaster).slug === "string" && typeof (r as TeamMaster).team_name === "string",
  )
}

export async function fetchFranchiseDirectory(
  db: RpcClient = supabaseAdmin as unknown as RpcClient,
): Promise<FranchiseDirectory> {
  const leagues = await Promise.all(
    LEAGUES.map(async (l): Promise<DirectoryLeague> => {
      try {
        const { data, error } = await withBoardBudget(
          Promise.resolve(db.rpc("get_teams_for_league", { p_league: l.value })),
          `franchise-directory:${l.value}`,
          LEAGUE_TIMEOUT_MS,
          "teams/",
        )
        if (error) {
          console.error(`[teams/franchise-directory] ${l.value}:`, error.message)
          return { league: l.value, label: l.label, emoji: l.emoji, state: "failed", teams: [] }
        }
        return { league: l.value, label: l.label, emoji: l.emoji, state: "ok", teams: asTeams(data) }
      } catch (e) {
        console.error(`[teams/franchise-directory] ${l.value} bound:`, e instanceof Error ? e.message : e)
        return { league: l.value, label: l.label, emoji: l.emoji, state: "failed", teams: [] }
      }
    }),
  )
  return { leagues, okLeagues: leagues.filter((l) => l.state === "ok").length }
}
