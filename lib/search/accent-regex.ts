// lib/search/accent-regex.ts
//
// #207 for free text that is NOT a person (pack titles, …), where there is no
// resolver to ask. A search backed by `ilike '%typed%'` is accent-SENSITIVE:
// "clasico" found none of Golazos' 23 "ElClásico" packs (89 of its 224 pack
// titles carry an accent, measured 2026-10-22).
//
// This builds the Postgres regex that matches `typed` with or without accents —
// each letter becomes the class of every character that folds to it
// ("clasico" → `cl[aáàâ…]s[iíì…][cçćč…]…`) — for PostgREST's `imatch` (~*). It
// is EXACT, unlike a widened ilike pattern: no over-match to trim, so a caller
// can re-run its real query with it and keep its count, sort and paging. The
// classes come from `foldForMatch`, the same fold every search box uses, so the
// database and the page agree on what "matches" means.

import { foldForMatch } from "@/lib/filter-match"

// Every single character in Latin-1 Supplement + Latin Extended-A/B, plus the
// curly apostrophes, grouped by the one character it folds to.
const VARIANTS: Map<string, Set<string>> = (() => {
  const m = new Map<string, Set<string>>()
  const add = (c: string) => {
    const f = foldForMatch(c)
    if (f.length !== 1 || f === c.toLowerCase()) return
    if (!m.has(f)) m.set(f, new Set([f, f.toUpperCase()]))
    // Single code points only: "İ".toLowerCase() is "i" + a combining dot.
    for (const v of [c, c.toLowerCase(), c.toUpperCase()]) if ([...v].length === 1) m.get(f)!.add(v)
  }
  for (let cp = 0x00c0; cp <= 0x024f; cp++) add(String.fromCodePoint(cp))
  for (const c of ["’", "‘", "ʼ", "`"]) add(c)
  return m
})()

const REGEX_SPECIAL = /[\\^$.|?*+()[\]{}]/

/**
 * A case-insensitive Postgres regex matching `typed` accent-blind, or null when
 * it would equal the plain text (nothing in it can carry an accent — re-running
 * would only repeat the search). Use with `.filter(column, "imatch", regex)`.
 */
export function accentInsensitiveRegex(typed: string): string | null {
  const folded = foldForMatch(typed.trim())
  if (!folded) return null
  let widened = false
  const parts: string[] = []
  for (const ch of folded) {
    const vs = VARIANTS.get(ch)
    if (vs) {
      widened = true
      parts.push("[" + [...vs].map((v) => (/[\\\]^-]/.test(v) ? "\\" + v : v)).join("") + "]")
    } else {
      parts.push(REGEX_SPECIAL.test(ch) ? "\\" + ch : ch)
    }
  }
  // foldForMatch DROPS the joiners (WALL•E → walle), so one may sit between any
  // two typed letters: "walle" must find "WALL•E".
  return widened ? parts.join("[•·]?") : null
}

type Read<T, E> = { data: T[] | null; error: E }

/**
 * Re-run an EMPTY, non-failed text search once with the accent-blind regex.
 * `run(regex)` must rebuild the query (a supabase-js builder mutates in place)
 * with `.filter(column, "imatch", regex)` in place of the ilike. A search that
 * matched, a failed read, or a failed (or throwing) retry is returned exactly as it was.
 */
export async function retryEmptyWithAccentRegex<T, E>(
  typed: string | null | undefined,
  first: Read<T, E>,
  run: (regex: string) => PromiseLike<Read<T, E>>,
): Promise<Read<T, E>> {
  const t = (typed ?? "").trim()
  if (!t || first.error || !Array.isArray(first.data) || first.data.length > 0) return first
  const rx = accentInsensitiveRegex(t)
  if (!rx) return first
  // The retry may only ever IMPROVE an answered empty: if it throws, the
  // original empty answer stands.
  let again: Read<T, E>
  try { again = await run(rx) } catch { return first }
  return again.error || !Array.isArray(again.data) ? first : again
}
