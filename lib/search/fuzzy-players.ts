// lib/search/fuzzy-players.ts
//
// "Closest matches" for a search that found NOTHING (2026-11-06). Measured live:
// "murry", "dontcic", "wemby", "jalen bruson" each returned 0 results, because
// rpc_search_catalog's player arm is an exact (accent-folded) substring match —
// so a new collector's first typo was a dead end.
//
// Runs ONLY on the empty-result path. It asks rpc_search_names_fuzzy for the
// ≤ 3 names nearest the query — players, team labels and set names (pg_trgm
// word_similarity ≥ 0.45; widened from players-only the same day, after
// "nugets" / "lakerz" / "playofs" still answered nothing) — then re-runs the
// ordinary rpc_search_catalog with each name and keeps that name's rows OF THAT
// KIND — the same mechanics as lib/search/accented-labels.ts, so a fuzzy hit is
// byte-identical to the hit a correctly typed query would get (counts,
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
export type FuzzyCandidate = { kind: "player" | "team" | "set"; name: string }

/** Minimum typed length before a fuzzy pass is attempted; shorter strings match everything. */
export const FUZZY_MIN_Q = 4
export const FUZZY_MAX_NAMES = 3

export async function fuzzyPlayerNames(db: FuzzyRpc, q: string, collectionId: string | null): Promise<FuzzyCandidate[]> {
  if (q.trim().length < FUZZY_MIN_Q) return []
  try {
    const { data, error } = await boundedRead(
      db.rpc("rpc_search_names_fuzzy", { p_q: q, p_collection_id: collectionId, p_limit: FUZZY_MAX_NAMES }),
      "api/search/rpc_search_names_fuzzy",
    )
    if (error || !Array.isArray(data)) {
      if (error) console.error("[search] fuzzy player names unavailable", error.message)
      return []
    }
    return (data as Array<Record<string, unknown>>)
      .filter((r) => typeof r.name === "string" && (r.name as string).trim() !== "" && (r.kind === "player" || r.kind === "team" || r.kind === "set"))
      .map((r) => ({ kind: r.kind as FuzzyCandidate["kind"], name: r.name as string }))
      .slice(0, FUZZY_MAX_NAMES)
  } catch (e) {
    console.error("[search] fuzzy player names threw", e instanceof Error ? e.message : e)
    return []
  }
}

/**
 * For an EMPTY exact result, the rows a fuzzy re-search finds (each candidate's
 * own kind only), plus the
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
  // In PARALLEL (2026-11-07 review): ≤ 3 independent re-searches ran one after
  // another on the zero-result path, ~4 round-trips of autocomplete latency.
  // Merged below in CANDIDATE order, so the answer is the one the serial loop gave.
  const results = await Promise.all(
    names.map(async ({ name }) => {
      try {
        return await boundedRead(
          db.rpc("rpc_search_catalog", { p_q: name, p_collection_id: collectionId, p_limit: limit }),
          "api/search/rpc_search_catalog_fuzzy",
        )
      } catch {
        return { data: null, error: { message: "threw" } }
      }
    }),
  )
  for (const [idx, { kind, name }] of names.entries()) {
    try {
      const { data, error } = results[idx] as { data: unknown; error: unknown }
      if (error || !Array.isArray(data)) continue
      let hit = false
      for (const r of data as T[]) {
        if (r.kind !== kind || r.label !== name || seen.has(key(r))) continue
        seen.add(key(r))
        rows.push(r)
        hit = true
      }
      if (hit) matched.push(name)
    } catch { /* a failed re-run adds nothing */ }
  }
  return rows.length ? { rows, fuzzy: { from: q, matched } } : { rows: [], fuzzy: null }
}
