// lib/search/fuzzy-players.ts
//
// "Closest matches" for a search that found NOTHING (2026-11-06). Measured live:
// "murry", "dontcic", "wemby", "jalen bruson" each returned 0 results, because
// rpc_search_catalog's player arm is an exact (accent-folded) substring match —
// so a new collector's first typo was a dead end.
//
// Runs ONLY on the empty-result path. It asks rpc_search_players_fuzzy for the
// ≤ 3 player names nearest the query (pg_trgm word_similarity ≥ 0.45), then
// re-runs the ordinary rpc_search_catalog with each name and keeps that name's
// PLAYER rows — the same mechanics as lib/search/accented-labels.ts, so a fuzzy
// hit is byte-identical to the hit a correctly typed query would get (counts,
// thumbnails, hub links). Nothing here invents a row.
//
// Honesty: the response says so. `meta.fuzzy = { from, matched }` names the
// typed query and the names actually searched, and the client labels the list
// "Closest matches for …" rather than presenting them as what was typed. A failed
// fuzzy read adds nothing and never fails the search (the exact answer — none —
// still stands).

import { boundedRead } from "@/lib/api/bounded-read"

export type FuzzyRpc = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>
}

export type FuzzyMeta = { from: string; matched: string[] }

/** Minimum typed length before a fuzzy pass is attempted; shorter strings match everything. */
export const FUZZY_MIN_Q = 4
export const FUZZY_MAX_NAMES = 3

export async function fuzzyPlayerNames(db: FuzzyRpc, q: string, collectionId: string | null): Promise<string[]> {
  if (q.trim().length < FUZZY_MIN_Q) return []
  try {
    const { data, error } = await boundedRead(
      db.rpc("rpc_search_players_fuzzy", { p_q: q, p_collection_id: collectionId, p_limit: FUZZY_MAX_NAMES }),
      "api/search/rpc_search_players_fuzzy",
    )
    if (error || !Array.isArray(data)) {
      if (error) console.error("[search] fuzzy player names unavailable", error.message)
      return []
    }
    return (data as Array<Record<string, unknown>>)
      .map((r) => r.name)
      .filter((n): n is string => typeof n === "string" && n.trim() !== "")
      .slice(0, FUZZY_MAX_NAMES)
  } catch (e) {
    console.error("[search] fuzzy player names threw", e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * For an EMPTY exact result, the player rows a fuzzy re-search finds, plus the
 * meta that labels them. Returns `null` meta when nothing fuzzy matched, so the
 * caller's empty answer stands unlabelled.
 */
export async function fuzzyPlayerHits<T extends { kind: string; label: string; collection_id: string; slug: string }>(
  db: FuzzyRpc,
  q: string,
  collectionId: string | null,
  limit: number,
): Promise<{ rows: T[]; fuzzy: FuzzyMeta | null }> {
  const names = await fuzzyPlayerNames(db, q, collectionId)
  if (names.length === 0) return { rows: [], fuzzy: null }
  const key = (r: T) => `${r.kind}|${r.collection_id}|${r.slug}`
  const seen = new Set<string>()
  const rows: T[] = []
  const matched: string[] = []
  for (const name of names) {
    try {
      const { data, error } = await boundedRead(
        db.rpc("rpc_search_catalog", { p_q: name, p_collection_id: collectionId, p_limit: limit }),
        "api/search/rpc_search_catalog_fuzzy",
      )
      if (error || !Array.isArray(data)) continue
      let hit = false
      for (const r of data as T[]) {
        if (r.kind !== "player" || r.label !== name || seen.has(key(r))) continue
        seen.add(key(r))
        rows.push(r)
        hit = true
      }
      if (hit) matched.push(name)
    } catch { /* a failed re-run adds nothing */ }
  }
  return rows.length ? { rows, fuzzy: { from: q, matched } } : { rows: [], fuzzy: null }
}
