// Shared pure logic for sync-nba-projections — the 3-tier NBA projection ingest
// (rpc-sports-proxy rolling-5 → DraftKings → ESPN scoreboard) that feeds
// nba_player_projections, which the /nba/fast-break optimizer reads. The parse/
// transform core decides which player resolves, which confidence label the row
// carries (a CHECK-constrained enum), and how a raw ESPN "rating" string becomes
// fantasy points.
//
// Ported VERBATIM from sync-nba-projections/index.ts (FUNCTION_VERSION 8). The
// deployed edge fn still carries inline copies; the source-drift guard in
// __tests__/edge-nba-projections-parse.test.ts fails CI if an inline copy's
// canonical expression is edited without mirroring it here.

/**
 * Position-based placeholder fantasy points for the roster-stub fallback (ESPN
 * returned games but every leader category was empty). Rough modern starting-
 * lineup season averages. Used only for espn-roster-stub rows (confidence LOW).
 */
export function placeholderFpFromPosition(pos: string | null): number {
  if (!pos) return 12
  const p = pos.toUpperCase()
  if (p.includes("C")) return 22
  if (p.includes("F")) return 18
  if (p.includes("G")) return 20
  return 12
}

/**
 * Mirrors public.normalize_player_name(): unaccent (NFD split + strip the
 * combining-mark range U+0300–U+036F) + strip non-alphabetic + lowercase. This is
 * the key the ingest resolves players by, so a drift here silently mis-resolves
 * or duplicates players (e.g. "Luka Dončić" → "lukadoncic"). The combining-mark
 * range is written as \u ESCAPES, never raw literals: raw U+0300–U+036F are two
 * invisible marks a Windows mount / editor re-encode / string-transported deploy
 * can silently drop, which would stop accent-stripping and auto-INSERT duplicate
 * nba_players rows. Escapes are byte-identical in behavior and safe to transport.
 */
export function normalizePlayerNameJs(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z]/g, "")
    .toLowerCase()
}

/**
 * nba_player_projections.confidence CHECK accepts only HIGH / MED / LOW (3-letter
 * MED — NOT "MEDIUM") or NULL; anything else aborts the WHOLE upsert batch. So an
 * upstream "MEDIUM" must map to "MED", and any unknown value must fall to null
 * rather than poison the batch. This is the exact two-vocabulary footgun CLAUDE.md
 * flags (fmv_snapshots uses MEDIUM; projections use MED).
 */
export function normalizeConfidence(raw: unknown): "HIGH" | "MED" | "LOW" | null {
  if (raw === null || raw === undefined) return null
  const s = String(raw).toUpperCase().trim()
  if (s === "HIGH") return "HIGH"
  if (s === "MED" || s === "MEDIUM") return "MED"
  if (s === "LOW") return "LOW"
  return null
}

/** Map an upstream injury-status string to the ACTIVE / QUESTIONABLE / OUT enum. */
export function mapInjuryStatus(raw: string | null): string {
  if (!raw) return "ACTIVE"
  const u = raw.trim().toUpperCase()
  if (u === "" || u === "NONE" || u === "GO" || u === "ACTIVE" || u === "AVAILABLE" || u === "PROBABLE") return "ACTIVE"
  if (u === "GTD" || u === "Q" || u === "QUESTIONABLE" || u === "DTD") return "QUESTIONABLE"
  if (u === "OUT" || u === "INJ" || u === "INJURED" || u === "OFS") return "OUT"
  return "ACTIVE"
}

/**
 * Game status from tip-off time relative to now: >4h past → final, within ±4h →
 * live, else scheduled. `nowMs` is injected (no wall-clock read) so the mapping
 * is deterministic and testable. Unknown/unparseable start → scheduled.
 */
export function deriveGameStatus(startTime: string | null, nowMs: number): "scheduled" | "live" | "final" {
  if (!startTime) return "scheduled"
  const ms = Date.parse(startTime)
  if (!Number.isFinite(ms)) return "scheduled"
  const fourHr = 4 * 60 * 60 * 1000
  const diff = nowMs - ms
  if (diff > fourHr) return "final"
  if (diff >= -fourHr) return "live"
  return "scheduled"
}

export interface GameMatch {
  gameId: string
  homeAbbr: string
  awayAbbr: string
}

/**
 * Resolve a player's team abbreviation to their game + opponent (case-insensitive,
 * home OR away). Returns null when the team isn't playing today / abbr missing.
 */
export function findGameForTeam(
  games: GameMatch[],
  teamAbbr: string | null,
): { gameId: string; opponentAbbr: string } | null {
  if (!teamAbbr) return null
  const ta = teamAbbr.trim().toUpperCase()
  for (const g of games) {
    if (g.homeAbbr.toUpperCase() === ta) return { gameId: g.gameId, opponentAbbr: g.awayAbbr }
    if (g.awayAbbr.toUpperCase() === ta) return { gameId: g.gameId, opponentAbbr: g.homeAbbr }
  }
  return null
}

/**
 * Parse a "23.9 PPG, 5.5 RPG, 9.9 APG, 1.4 SPG, 0.8 BPG" ESPN rating display.
 * Each stat is optional (missing → 0). Returns null when there's no real signal
 * (pts, reb, ast all 0) — an empty leader category, not a 0-stat player.
 */
export function parseRatingString(
  s: string,
): { pts: number; reb: number; ast: number; stl: number; blk: number } | null {
  if (!s) return null
  const grab = (re: RegExp): number => {
    const m = s.match(re)
    if (!m) return 0
    const n = parseFloat(m[1])
    return Number.isFinite(n) ? n : 0
  }
  const pts = grab(/([\d.]+)\s*PPG/i)
  const reb = grab(/([\d.]+)\s*RPG/i)
  const ast = grab(/([\d.]+)\s*APG/i)
  const stl = grab(/([\d.]+)\s*SPG/i)
  const blk = grab(/([\d.]+)\s*BPG/i)
  if (pts === 0 && reb === 0 && ast === 0) return null
  return { pts, reb, ast, stl, blk }
}

/**
 * DraftKings-style fantasy points from base stats (no threes/TOV/DD2/TD3 in the
 * rating string, so this is an approximation): pts + 1.2·reb + 1.5·ast + 3·stl +
 * 3·blk, rounded 2dp.
 */
export function dkFantasyFromBaseStats(s: {
  pts: number
  reb: number
  ast: number
  stl: number
  blk: number
}): number {
  const fp = s.pts + 1.2 * s.reb + 1.5 * s.ast + 3 * s.stl + 3 * s.blk
  return Math.round(fp * 100) / 100
}
