// lib/topshot/rookie-cut-lines.ts
//
// Year-end rookie cut lines for a Top Shot rookie player page (2026-11-27).
//
// Top Shot's 2026-27 rookie program rewards leaderboards once the NBA names its
// All-Rookie teams (a one-week clock, then the boards lock):
//   - Blue Chip /3     — the top 3 holders of each ALL-ROOKIE player;
//   - Rookie Yearbook  — the top 26 holders of every rookie with a Moment this season.
// Source: blog.nbatopshot.com/posts/rookies-on-nba-top-shot-in-2026-27.
//
// RPC already measures the #3 and #26 lines: get_topshot_player_rank_thresholds
// (20261020222800) over topshot_rookie_collector_leaderboard_mv, Top Shot system
// accounts excluded. Its own COMMENT calls it a PROXY for Top Shot's locked-TSS
// boards — it counts every walk-confirmed holding at FMV, locked or not — so the page
// labels it a guide, never Top Shot's own number.
//
// Honesty (three states, CLAUDE.md):
//   - read failed                → null: the strip renders nothing (it is additive, so
//                                   its absence claims nothing);
//   - read ok, NULL row for a cut → that line is OPEN ("fewer than N collectors"), never $0;
//   - read ok, rows               → the lines.
// Only the 2026 class gets the strip: the program is the 2026-27 season's, and a
// 2025-class player is on the same MV but earns no Yearbook this year.

import { supabaseAdmin } from "@/lib/supabase"
import { sectionRowsResult } from "@/lib/entity-section-rpc"
import { boundedRead } from "@/lib/api/bounded-read"

/** One row of get_topshot_player_rank_thresholds. Numerics arrive as strings from PostgREST. */
export type RankThresholdRow = {
  rank_cutoff: number | string
  est_value_usd: number | string | null
  moments_held: number | string | null
  collectors: number | string | null
}

export type RookieCutLine = {
  rank: 3 | 26
  /** Short reward name shown beside the rank. */
  reward: "Blue Chip" | "Rookie Yearbook"
  /** True when the board has fewer collectors than `rank`: anyone holding one Moment is inside the line. */
  open: boolean
  moments: number | null
  valueUsd: number | null
}

export type RookieCutLines = { collectors: number | null; lines: RookieCutLine[] }

const num = (v: unknown): number | null => {
  if (v == null) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

const CUTS: ReadonlyArray<{ rank: 3 | 26; reward: RookieCutLine["reward"] }> = [
  { rank: 3, reward: "Blue Chip" },
  { rank: 26, reward: "Rookie Yearbook" },
]

/**
 * Turn the function's rows into the two lines the page shows. Returns null when there
 * is nothing to say: no rows, or a board with zero collectors.
 */
export function buildRookieCutLines(rows: RankThresholdRow[]): RookieCutLines | null {
  if (!Array.isArray(rows) || rows.length === 0) return null
  const byCut = new Map<number, RankThresholdRow>()
  for (const r of rows) {
    const cut = num(r.rank_cutoff)
    if (cut != null) byCut.set(cut, r)
  }
  const collectors = rows.map((r) => num(r.collectors)).find((c) => c != null) ?? null
  // The function LEFT JOINs the cuts onto the board, so a player with no board still
  // gets four rows — every one NULL with collectors = 0. Nothing to show.
  if (collectors === 0) return null
  const lines = CUTS.map(({ rank, reward }) => {
    const r = byCut.get(rank)
    const moments = num(r?.moments_held)
    const valueUsd = num(r?.est_value_usd)
    // A missing row or a NULL holding = fewer collectors than this rank.
    const open = r == null || moments == null
    return { rank, reward, open, moments: open ? null : moments, valueUsd: open ? null : valueUsd }
  })
  return { collectors, lines }
}

/** Is this player in the 2026 rookie class? null = the read failed (caller shows nothing). */
async function isTopShot2026Rookie(playerName: string): Promise<boolean | null> {
  // Bounded: a slow read returns an error envelope (→ null, no strip) instead of
  // hanging the page's Suspense boundary (scripts/check-unbounded-server-reads.mjs).
  const { data, error } = await boundedRead(
    (supabaseAdmin as any)
      .from("topshot_2026_rookie_players")
      .select("player_name")
      .eq("player_name", playerName)
      .limit(1),
    "player/rookie-cut-lines/class",
  )
  if (error) {
    console.error("[rookie-cut-lines] topshot_2026_rookie_players", error.message)
    return null
  }
  return Array.isArray(data) && data.length > 0
}

/**
 * The cut lines for a 2026-class Top Shot rookie, or null when the player is not in
 * the class, is not on the board, or either read failed.
 */
export async function fetchRookieCutLines(playerName: string): Promise<RookieCutLines | null> {
  const [inClass, thresholds] = await Promise.all([
    isTopShot2026Rookie(playerName),
    sectionRowsResult<RankThresholdRow>("player rank thresholds", "get_topshot_player_rank_thresholds", {
      p_player_name: playerName,
    }),
  ])
  if (inClass !== true) return null
  if (!thresholds.ok) return null
  return buildRookieCutLines(thresholds.rows)
}
