// lib/concierge/player-games-tool.ts
//
// The concierge's get_player_games tool: one person's most recent games (ESPN box
// scores, ingested by the espn-game-logs lane) beside that collection's player market
// cap the day before and the day after each game. Reads get_player_recent_games
// (migrations 20261108184347 / 20261108184457), which filters to ONE person first.
//
//   Top Shot / All Day / Candy → keyed on the RESOLVED PERSON (players.id through
//                                player_identities), never the bare name
//   Golazos / Panini           → keyed on the market-cap name slug through their
//                                one-person crosswalks (no league id exists for them)
//   Disney Pinnacle / UFC      → not applicable (characters; a closed market)
//
// Honesty (four states, never collapsed):
//   error       the read failed — the model says it could not check
//   not_linked  no game feed is tied to this person (retired, a league RPC does not read,
//               or a name that is more than one athlete) — never "did not play"
//   ambiguous   two ESPN athletes behind one person/slug — ask, never merge
//   no_games    linked, but no game since the feed starts — say from when
// A market-cap move is reported with its supply change beside it: a day's move mixes
// price with new mints/burns, and one game is not evidence of anything.

import { getCollectionByUrlSlug } from "@/lib/collection-slug"
import { slugifyPlayerName } from "@/lib/entity-labels"

export type PersonResolution =
  | { status: "ok"; playerId: string | null; slug: string; label: string }
  | { status: "stop"; payload: Record<string, unknown> }

export interface PlayerGamesToolDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any
  /** Person resolver (resolve_player_name): the players.id + page slug, or a stop payload. */
  resolvePerson: (collectionUuid: string, name: string) => Promise<PersonResolution>
}

type Stats = Record<string, Record<string, string>>

interface RawGame {
  date: string
  league: string
  opponent: string | null
  is_home: boolean | null
  did_not_play: boolean
  minutes: number | null
  fantasy_points: number | null
  stats: Stats | null
  mcap_before: number | null
  mcap_after: number | null
  held_before: number | null
  held_after: number | null
}

interface RawResult {
  linked: number
  espn_ids: string[]
  games: RawGame[]
  season_avg_fp: number | null
  games_in_season: number
  first_game_date: string | null
  mcap_now: number | null
}

const NOT_APPLICABLE: Record<string, string> = {
  disney_pinnacle: "Disney Pinnacle pins are characters, not athletes — there are no games to read.",
  ufc_strike: "UFC Strike is not linked to fight results, and its market is closed (no market cap to compare).",
}

export const PLAYER_GAMES_METHOD =
  "Box scores are ESPN's. fantasy_points: DraftKings classic for NBA/WNBA, half-PPR for NFL, an RPC index for soccer (appearance 1, goal 6, assist 4, shot on target 1, save 0.5, yellow -1, red -3, own goal -2), none for MLB. " +
  "Market cap = FMV × collector-held supply for this player in this collection, read the day before and the day after the game. " +
  "A day's move mixes price with supply (new mints, burns) and market noise; a single game is not evidence that performance moved the price."

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

/** A short human line for one game, by sport. Exported for tests. */
export function statLine(league: string, stats: Stats | null): string | null {
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

function round2(v: number | null): number | null {
  return v == null ? null : Math.round(v * 100) / 100
}

/** The market-cap move around one game, with the supply change beside it. Exported for tests. */
export function marketMove(g: Pick<RawGame, "mcap_before" | "mcap_after" | "held_before" | "held_after">) {
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
    note,
  }
}

export async function runPlayerGamesTool(
  input: Record<string, unknown>,
  activeCollectionUrlSlug: string,
  deps: PlayerGamesToolDeps,
): Promise<Record<string, unknown>> {
  const name = String(input.name ?? "").trim()
  if (!name) return { status: "error", message: "A player name is required." }
  const limit = Math.min(Math.max(Math.trunc(Number(input.limit)) || 5, 1), 15)
  const urlSlug = String(input.collectionId ?? "").trim() || activeCollectionUrlSlug
  const info = getCollectionByUrlSlug(urlSlug)
  // An unknown collection is refused — never answered with another collection's player.
  if (!info) return { status: "error", message: `Unknown collection '${urlSlug}'.` }
  const na = NOT_APPLICABLE[info.dbSlug]
  if (na) return { status: "not_applicable", collection: info.dbSlug, message: na }

  const person = await deps.resolvePerson(info.id, name)
  if (person.status === "stop") return person.payload

  const slugs = Array.from(new Set([person.slug, marketCapKey(person.label), marketCapKey(name)].filter((s) => s && s.length > 0)))
  const byPerson = info.dbSlug === "nba_top_shot" || info.dbSlug === "nfl_all_day" || info.dbSlug === "candy_mlb"
  const { data, error } = await deps.supabase.rpc("get_player_recent_games", {
    p_collection_slug: info.dbSlug,
    p_slugs: slugs,
    p_player_id: byPerson ? person.playerId : null,
    p_limit: limit,
  })
  if (error || !data || typeof data !== "object") {
    return { status: "error", player: person.label, message: "The game log could not be read just now — say you could not check, never that the player has no games." }
  }
  const r = data as RawResult

  if (!r.linked) {
    return {
      status: "not_linked",
      player: person.label,
      collection: info.dbSlug,
      message: `No game-by-game feed is linked to ${person.label} in ${info.displayName}. That happens for retired players, leagues RPC does not read, and names that belong to more than one athlete. Say that — do not say they did not play.`,
    }
  }
  if (r.linked > 1) {
    return {
      status: "ambiguous",
      player: person.label,
      collection: info.dbSlug,
      message: `More than one athlete matches ${person.label} in this collection's game feed — ask which one (team or era) and never combine their games.`,
    }
  }
  if (!r.games?.length) {
    return {
      status: "no_games",
      player: person.label,
      collection: info.dbSlug,
      message: `${person.label} is linked to the game feed, but no game is recorded since the feed starts (October 2026 for most leagues; August 2026 for LaLiga). Say that plainly.`,
    }
  }

  return {
    status: "ok",
    player: person.label,
    collection: info.dbSlug,
    market_cap_now_usd: round2(r.mcap_now),
    season_average_fantasy_points: r.season_avg_fp,
    games_this_season_counted: r.games_in_season,
    games: r.games.map((g) => ({
      date: g.date,
      league: g.league,
      opponent: g.opponent,
      home_or_away: g.is_home == null ? null : g.is_home ? "home" : "away",
      did_not_play: g.did_not_play,
      line: g.did_not_play ? "did not play" : statLine(g.league, g.stats),
      fantasy_points: g.did_not_play ? null : round2(g.fantasy_points),
      vs_season_average: g.did_not_play || g.fantasy_points == null || r.season_avg_fp == null ? null : round2(g.fantasy_points - r.season_avg_fp),
      market: marketMove(g),
    })),
    method: PLAYER_GAMES_METHOD,
  }
}