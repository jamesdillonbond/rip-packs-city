// lib/concierge/feedback-dedupe.ts — one report, one row (2026-10-24).
//
// webz_80's 10-11 session produced FOUR beta_feedback rows for two asks: the
// user re-phrased the same complaint a minute later and the bot logged the bug
// and the feature request again (10792/10793 then 10795/10796). Triage had to
// mark three duplicates by hand. logBetaFeedback now asks this first: a row of
// the SAME type, in the SAME session, in the last DEDUPE_WINDOW_MS, whose summary
// shares enough words is the same report.

export const DEDUPE_WINDOW_MS = 30 * 60 * 1000
export const MIN_OVERLAP = 0.25

const STOP = new Set([
  "a", "an", "the", "and", "or", "of", "to", "for", "in", "on", "at", "is", "it", "be", "as", "by", "with", "from",
  "that", "this", "vs", "instead", "when", "only", "page", "option", "should", "can", "not", "no", "per", "new",
])

function stem(w: string): string {
  let s = w
  for (const suf of ["ations", "ation", "ings", "ing", "ed", "es", "s"]) {
    if (s.length > suf.length + 2 && s.endsWith(suf)) { s = s.slice(0, -suf.length); break }
  }
  if (s.startsWith("re") && s.length > 5) s = s.slice(2)
  return s
}

export function summaryWords(text: string): Set<string> {
  return new Set(
    text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)).map(stem),
  )
}

/** Jaccard overlap of the two summaries' content words. */
export function summaryOverlap(a: string, b: string): number {
  const A = summaryWords(a), B = summaryWords(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const w of A) if (B.has(w)) inter++
  return inter / (A.size + B.size - inter)
}

export function isSameReport(a: string, b: string): boolean {
  return summaryOverlap(a, b) >= MIN_OVERLAP
}
