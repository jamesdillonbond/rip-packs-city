// lib/market/canonical-badges.ts
//
// Edition badges for the Top Shot and All Day MARKET rows, read from the same
// canonical rule the edition page uses.
//
// ── Why this exists (2026-10-13, register R104) ─────────────────────────────
// The market had two badge sources for these collections and BOTH were empty
// by construction:
//   • Top Shot rows were mapped with `badge_slugs: null`, and the enrichment
//     fell back to `editions.badges`;
//   • All Day rows took `badges` from `get_allday_market_editions`, which
//     SELECTs `e.badges` — the same column.
// `editions.badges` is an always-empty `text[]` for every Top Shot and All Day
// edition (populated only for Candy MLB). So the Badges column rendered blank
// on every row, the Badges chip had no options, and a `?badges=` link matched
// nothing. Measured on production 2026-10-13 ~6 AM PT, page 1 sorted by most
// recent: All Day 0 badges shown vs 44 of 100 editions badged in the canonical
// source; Top Shot 0 shown vs 2 of 47. An empty cell under a "Badges" heading
// reads as "this moment has no badges" — a failed source publishing an answer.
//
// ── Why get_edition_badge_titles, and not a TS copy of the rule ─────────────
// `get_edition_badge_titles(p_collection_id, p_route_slugs[])` runs the
// canonical `get_edition_badges_unified(id)` per edition and returns
// `{ external_id: [title, …] }`. It already backs /api/entity/edition-badges,
// so the market, the editions grid and the edition page cannot disagree.
// Re-deriving the rule here (whitelist of play tags, set-play tags, the rookie
// mint flag, the Candy arm …) would be a second copy that drifts.
// Cost, measured warm 2026-10-13: 500 Top Shot keys 204 ms / ~5.6k buffers;
// 100 All Day keys 246 ms / ~2.5k buffers. The function caps at 500 slugs, so
// a 1,000-row window is read in two chunks.
//
// ── THREE states, never two ─────────────────────────────────────────────────
// `{ ok: true, titles }` — read clean (an edition absent from the map, or with
// `[]`, genuinely has no badges) · `{ ok: false }` — the read failed. A failed
// read is NEVER returned as an empty map: the caller decides between degrading
// to "no badges" (display only) and refusing the request (a badge FILTER, where
// an empty or unfiltered answer would be a false claim). ANY chunk failing fails
// the whole read — a partial map would show "no badges" on exactly the rows
// whose chunk failed, indistinguishable from a real absence.

import { boundedRead } from "@/lib/api/bounded-read"

export const CANONICAL_BADGE_CHUNK = 500

export type CanonicalBadgeRead =
  | { ok: true; titles: Map<string, string[]> }
  | { ok: false; error: string }

/**
 * Canonical badge titles for `keys` (edition `external_id`s) in one collection.
 * Empty/blank keys are dropped and duplicates collapsed before chunking.
 */
export async function readCanonicalBadgeTitles(
  supa: { rpc: (fn: string, args: Record<string, unknown>) => unknown },
  collectionId: string,
  keys: readonly (string | null | undefined)[],
  label = "api/market/canonical_badges",
): Promise<CanonicalBadgeRead> {
  const unique = [...new Set(keys.filter((k): k is string => typeof k === "string" && k.trim() !== ""))]
  const titles = new Map<string, string[]>()
  if (unique.length === 0) return { ok: true, titles }

  const chunks: string[][] = []
  for (let i = 0; i < unique.length; i += CANONICAL_BADGE_CHUNK) {
    chunks.push(unique.slice(i, i + CANONICAL_BADGE_CHUNK))
  }
  const results = await Promise.all(
    chunks.map((chunk, i) =>
      boundedRead(
        supa.rpc("get_edition_badge_titles", { p_collection_id: collectionId, p_route_slugs: chunk }) as never,
        `${label}#${i}`,
      ),
    ),
  )
  for (const { data, error } of results) {
    if (error) {
      const msg = typeof error?.message === "string" && error.message ? error.message : String(error?.code ?? "unknown error")
      return { ok: false, error: msg }
    }
    // The function returns a jsonb OBJECT; anything else is a contract break,
    // not "no badges".
    if (data == null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: `unexpected get_edition_badge_titles payload: ${Array.isArray(data) ? "array" : typeof data}` }
    }
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue
      const list = value.filter((t): t is string => typeof t === "string" && t.trim() !== "")
      titles.set(key, list)
    }
  }
  return { ok: true, titles }
}

/**
 * Apply the market's badge filter to rows that already carry `badgeSlugs`.
 * `badges` non-empty → rows carrying ANY of them (the chip is multi-select,
 * matching the legacy path's `overlaps`); else `hasBadges` → rows carrying any
 * badge; else unchanged.
 */
export function filterRowsByBadges<T extends { badgeSlugs: readonly string[] }>(
  rows: T[],
  badges: readonly string[],
  hasBadges: boolean,
): T[] {
  if (badges.length > 0) {
    const wanted = new Set(badges)
    return rows.filter((r) => r.badgeSlugs.some((b) => wanted.has(b)))
  }
  if (hasBadges) return rows.filter((r) => r.badgeSlugs.length > 0)
  return rows
}
