// lib/market/player-match.ts
//
// Known-issues #207 (2026-10-21): every /api/market arm matches the Player box
// with an accent-SENSITIVE `ilike '%q%'` (the Top Shot / All Day / Golazos RPCs
// and the PostgREST table arms alike), so "luka doncic" found no listing for
// "Luka Dončić" and the page read as an empty market for a player with live asks.
//
// Two server-side fallbacks, both run ONLY when the ordinary search came back
// EMPTY — a search that already matched is never touched, and costs nothing extra:
//
// 1. Catalog arms (Top Shot, All Day, Golazos): resolve the typed text against
//    the collection's player catalog. Exactly one name that matches only once
//    accents are ignored → search that name, and SAY SO in the response
//    (`playerResolved`), so the page can show "Showing results for …". Never a
//    silent subject swap: that is the substitution shape CLAUDE.md refuses.
//    Two or more candidates → no guess; the page offers them as "Did you mean".
//
// 2. Table arms (Pinnacle, Candy, Panini — they fetch a window and page in code):
//    retry with an accent-TOLERANT ilike pattern (letters that commonly carry a
//    diacritic become `_`), then keep only rows whose name matches the typed text
//    exactly once accents are folded. The pattern over-matches; the fold decides.

import { foldForMatch, textIncludes } from "@/lib/filter-match"

/**
 * Whether Postgres `ILIKE '%typed%'` — what every market arm runs — would match.
 * ⚠ DELIBERATELY accent-SENSITIVE: it models what the database will find, not what
 * a person means (that is `textIncludes`). The one sanctioned case-only comparison;
 * `__tests__/a-search-box-matches-accented-names.test.ts` names it.
 */
export function ilikeWouldMatch(value: string, typed: string): boolean {
  return value.toLowerCase().includes(typed.toLowerCase())
}

/** Names that match `typed` only once accents are ignored (ilike would miss every one). */
export function accentOnlyMatches(typed: string, names: readonly string[]): string[] {
  const t = typed.trim()
  if (!t) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const n of names) {
    if (seen.has(n)) continue
    seen.add(n)
    if (textIncludes(n, t) && !ilikeWouldMatch(n, t)) out.push(n)
  }
  return out
}

/**
 * The single catalog name an empty search should be retried with, or null.
 * Null when the typed text already matches some name as typed (an empty result
 * then is a true empty), when nothing matches, or when the match is ambiguous.
 */
export function resolveAccentedPlayer(typed: string, names: readonly string[]): string | null {
  const t = typed.trim()
  if (!t) return null
  if (names.some((n) => ilikeWouldMatch(n, t))) return null
  const hits = accentOnlyMatches(t, names)
  return hits.length === 1 ? hits[0] : null
}

// Letters that most often carry a diacritic in the names we hold (á é í ó ú ü ý
// ñ ç č ć š ž ģ), plus the apostrophe (the catalog stores the curly ’ in
// "Aiden O’Neill"). Each becomes `_` (one character) in the ilike pattern.
// Measured 2026-10-21 over every edition / Candy / Panini / Pinnacle name: no
// ł ř ğ occurs, so those stay literal rather than widen every retry window.
// ø and other non-decomposing letters fold in foldForMatch (o is widened).
const ACCENTABLE = /[aeiouycnszg']/g

/**
 * An ilike body that matches `typed` with or without accents, or null when it
 * would not differ from the typed text (nothing to widen). Over-matches by
 * design — callers MUST re-check rows with `textIncludes(name, typed)`.
 * `%` and `_` in the typed text are escaped so they stay literal.
 */
export function accentTolerantPattern(typed: string): string | null {
  const folded = foldForMatch(typed.trim())
  if (!folded) return null
  const escaped = folded.replace(/[\\%_]/g, (c) => "\\" + c)
  const widened = escaped.replace(ACCENTABLE, "_")
  // Keep at least a few literal characters so a short query cannot become
  // "%____%" and pull an arbitrary window.
  const literal = widened.replace(/[_\s\\%]/g, "").length
  if (widened === escaped || literal < 2) return null
  return widened
}

/**
 * Retry an EMPTY player search on a table arm with the tolerant pattern and keep
 * only the rows the fold confirms. `run` re-runs the arm with a different player
 * ilike body; `nameOf` reads a returned row's matched name. A null (failed) read
 * passes through untouched, so a failure is never reported as an empty market.
 */
export async function withAccentFallback<T>(
  typed: string,
  run: (playerIlikeBody: string) => Promise<T[] | null>,
  nameOf: (row: T) => string | null | undefined,
): Promise<T[] | null> {
  const first = await run(typed)
  if (!typed.trim() || first === null || first.length > 0) return first
  const pattern = accentTolerantPattern(typed)
  if (!pattern) return first
  const wide = await run(pattern)
  if (wide === null) return first
  return wide.filter((r) => textIncludes(nameOf(r) ?? "", typed))
}
