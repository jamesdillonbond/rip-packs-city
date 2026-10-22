// Type-to-filter matching for long filter lists (components/filters/*).
//
// - Accent- and case-insensitive: "atletico" finds "Atlético de Madrid",
//   "malaga" finds "Málaga CF" (LaLiga Golazos), "dončić" and "doncic" agree.
// - Every word of the query must appear ("port blaz" finds "Portland Trail Blazers").
// - Ranked: the whole label starting with the query, then a word starting with
//   it, then a match anywhere; ties keep the list's own order.

// Letters NFD does not decompose, so stripping combining marks leaves them as-is:
// "sorloth" missed "Alexander Sørloth" (measured 2026-10-21: ø in 2 catalog names).
// Curly apostrophes become straight ones — "o'neill" missed "Aiden O’Neill", and ’
// sits in 5 catalog names — and the WALL•E-style joiners drop out. Postgres
// `unaccent` (resolve_player_name) folds the same letters, so both sides agree.
const NON_DECOMPOSING: Record<string, string> = {
  "ø": "o", "Ø": "o", "ł": "l", "Ł": "l", "đ": "d", "Đ": "d", "ħ": "h", "Ħ": "h", "ı": "i",
  "ß": "ss", "æ": "ae", "Æ": "ae", "œ": "oe", "Œ": "oe", "þ": "th", "Þ": "th",
  "’": "'", "‘": "'", "ʼ": "'", "`": "'", "•": "", "·": "",
}
const NON_DECOMPOSING_RE = /[øØłŁđĐħĦıßæÆœŒþÞ’‘ʼ`•·]/g

/** Lower-case and strip diacritics so "Atlético" and "atletico" compare equal. */
export function foldForMatch(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(NON_DECOMPOSING_RE, (c) => NON_DECOMPOSING[c] ?? c).toLowerCase()
}

function queryWords(query: string): string[] {
  return foldForMatch(query).trim().split(/\s+/).filter(Boolean)
}

/** 0 = label starts with the query, 1 = a word starts with it, 2 = contains it, -1 = no match. */
export function matchRank(label: string, query: string): number {
  const words = queryWords(query)
  if (words.length === 0) return 0
  const hay = foldForMatch(label)
  if (!words.every(w => hay.includes(w))) return -1
  const whole = words.join(" ")
  if (hay.startsWith(whole)) return 0
  const wordStarts = hay.split(/[\s\-–—/.,'’()]+/)
  if (words.every(w => wordStarts.some(ws => ws.startsWith(w)))) return 1
  return 2
}

/** Options matching `query`, best first; the original order breaks ties. */
export function filterOptions<T>(options: readonly T[], query: string, labelOf: (o: T) => string = String): T[] {
  if (queryWords(query).length === 0) return [...options]
  return options
    .map((o, i) => ({ o, i, r: matchRank(labelOf(o), query) }))
    .filter(x => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(x => x.o)
}

/**
 * Split `label` into plain / matched runs for highlighting. Folding keeps one
 * character per character for the Latin labels we carry (NFD then dropping the
 * combining marks), so indexes in the folded string map back to the label; if a
 * label ever folds to a different length we return it unhighlighted.
 */
export function highlightParts(label: string, query: string): Array<{ text: string; match: boolean }> {
  const words = queryWords(query)
  const folded = foldForMatch(label)
  if (words.length === 0 || folded.length !== label.length) return [{ text: label, match: false }]
  const hit = new Array<boolean>(label.length).fill(false)
  for (const w of words) {
    let from = 0
    for (;;) {
      const at = folded.indexOf(w, from)
      if (at < 0) break
      for (let k = at; k < at + w.length; k++) hit[k] = true
      from = at + w.length
    }
  }
  const parts: Array<{ text: string; match: boolean }> = []
  for (let k = 0; k < label.length; k++) {
    const last = parts[parts.length - 1]
    if (last && last.match === hit[k]) last.text += label[k]
    else parts.push({ text: label[k], match: hit[k] })
  }
  return parts
}

/**
 * Accent- and case-blind substring test for a free-text search box: "doncic"
 * finds "Luka Dončić", "atletico" finds "Atlético". For plain ASCII it is exactly
 * `haystack.toLowerCase().includes(needle.toLowerCase())`.
 */
export function textIncludes(haystack: string | null | undefined, needle: string): boolean {
  return foldForMatch(haystack ?? "").includes(foldForMatch(needle))
}
