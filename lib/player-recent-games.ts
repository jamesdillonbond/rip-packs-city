// lib/player-recent-games.ts
//
// Shared shape + pure helpers for get_player_recent_games (migrations 20261108184347 /
// 20261108184457): one person's most recent ESPN box scores beside that collection's
// player market cap the day before and the day after each game. Two readers:
//   · the concierge's get_player_games tool (lib/concierge/player-games-tool.ts)
//   · the player page's "Recent Games" section (components/entity/PlayerRecentGames.tsx)
//
// A market-cap move is always shown with its supply change beside it: a day's move
// mixes price with new mints/burns, and one game is not evidence of anything.

import { slugifyPlayerName } from "@/lib/entity-labels"

export type GameStats = Record<string, Record<string, string>>

export interface RecentGame {
  date: string
  league: string
  opponent: string | null
  is_home: boolean | null
  did_not_play: boolean
  minutes: number | null
  fantasy_points: number | null
  stats: GameStats | null
  mcap_before: number | null
  mcap_after: number | null
  held_before: number | null
  held_after: number | null
}

export interface RecentGamesResult {
  linked: number
  espn_ids: string[]
  games: RecentGame[]
  season_avg_fp: number | null
  games_in_season: number
  first_game_date: string | null
  mcap_now: number | null
}

/** Collections with a game feed. Pinnacle (characters) and UFC (closed market, no fight feed) have none. */
export const RECENT_GAMES_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day", "candy_mlb", "laliga_golazos", "panini_blockchain"])

/** Collections read by the RESOLVED PERSON (players.id → player_identities); the rest by name slug through a one-person crosswalk. */
export const RECENT_GAMES_PERSON_COLLECTIONS = new Set(["nba_top_shot", "nfl_all_day", "candy_mlb"])

/** Accent-folded slug with edge dashes trimmed — the market-cap key shape. */
export function marketCapKey(name: string): string {
  return slugifyPlayerName(name).replace(/^-+|-+$/g, "")
}

function n(v: string | undefined): number | null {
  if (v == null) return null
  const t = v.replace(/,/g, "").trim()
  const m = t.match(/^[+-]?\d+(\.\d+)?/)
  return m ? Number(m[0]) : null
}

/** A short human line for one game, by sport. MLB has no line yet (null — never a fabricated one). */
export function statLine(league: string, stats: GameStats | null): string | null {
  if (!stats) return null
  if (league === "nba" || league === "wnba") {
    const s = stats.line
    if (!s) return null
    const parts = [`${s.points ?? "?"} pts`, `${s.rebounds ?? "?"} reb`, `${s.assists ?? "?"} ast`]
    if ((n(s.steals) ?? 0) > 0) parts.push(`${s.steals} stl`)
    if ((n(s.blocks) ?? 0) > 0) parts.push(`${s.blocks} blk`)
    if (s.minutes) parts.push(`${s.minutes} min`)
    return parts.join(", ")
  }
  if (league === "nfl") {
    const parts: string[] = []
    const p = stats.passing
    if (p) parts.push(`${p["completions/passingAttempts"] ?? "?"} passing, ${p.passingYards ?? "?"} yds, ${p.passingTouchdowns ?? "0"} TD, ${p.interceptions ?? "0"} INT`)
    const r = stats.rushing
    if (r) parts.push(`${r.rushingAttempts ?? "?"} rushes for ${r.rushingYards ?? "?"} yds, ${r.rushingTouchdowns ?? "0"} TD`)
    const c = stats.receiving
    if (c) parts.push(`${c.receptions ?? "?"} catches for ${c.receivingYards ?? "?"} yds, ${c.receivingTouchdowns ?? "0"} TD`)
    const d = stats.defensive
    if (!parts.length && d) parts.push(`${d.totalTackles ?? "?"} tackles, ${d.sacks ?? "0"} sacks`)
    return parts.length ? parts.join("; ") : null
  }
  if (league === "mlb") return null
  const s = stats.line
  if (!s) return null
  const parts = [`${s.totalGoals ?? "0"} goals`, `${s.goalAssists ?? "0"} assists`, `${s.shotsOnTarget ?? "0"} on target`]
  if ((n(s.saves) ?? 0) > 0) parts.push(`${s.saves} saves`)
  if ((n(s.yellowCards) ?? 0) > 0) parts.push(`${s.yellowCards} yellow`)
  if ((n(s.redCards) ?? 0) > 0) parts.push(`${s.redCards} red`)
  return parts.join(", ")
}

export function round2(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100
}

/** The market-cap move around one game, with the supply change beside it. */
export function marketMove(g: Pick<RecentGame, "mcap_before" | "mcap_after" | "held_before" | "held_after">) {
  if (g.mcap_before == null || g.mcap_after == null || g.mcap_before <= 0) {
    return { market_cap_before_usd: round2(g.mcap_before), market_cap_after_usd: round2(g.mcap_after), change_pct: null, note: "No market-cap reading on one side of this game (the daily series starts 2026-10-03)." }
  }
  const pct = Math.round(((g.mcap_after / g.mcap_before) - 1) * 1000) / 10
  const supplyDelta = g.held_before != null && g.held_after != null ? g.held_after - g.held_before : null
  // The note is PROPORTIONAL. Live 2026-11-08: a +17 change on 220,775 held (0.008 %) beside an
  // −11.9 % move was read out as "part of each move is supply" — true in arithmetic, false in
  // substance. Supply is named as a driver only when it is a real share of the move.
  let note: string | undefined
  if (supplyDelta != null && supplyDelta !== 0 && g.held_before) {
    const supplyPct = (supplyDelta / g.held_before) * 100
    const shown = `${supplyDelta > 0 ? "+" : ""}${supplyDelta} of ${g.held_before.toLocaleString("en-US")} held, ${Math.abs(supplyPct) < 0.01 ? "<0.01" : Math.abs(supplyPct).toFixed(2)}%`
    note = Math.abs(supplyPct) >= Math.max(0.5, Math.abs(pct) * 0.25)
      ? `Collector-held supply changed by ${shown} over the same two days — a real part of this move is supply (new mints or burns), not price.`
      : `Collector-held supply barely changed (${shown}), so this move is price, not supply.`
  }
  return {
    market_cap_before_usd: round2(g.mcap_before),
    market_cap_after_usd: round2(g.mcap_after),
    change_pct: pct,
    collector_held_change: supplyDelta,
    /** true when the supply change is a real share of the move (the note then names supply). */
    supply_driven: note != null && note.includes("real part of this move is supply"),
    note,
  }
}
