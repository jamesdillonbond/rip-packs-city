// A PARALLEL is a printing of the same play/card that is its own edition — its
// own circulation, its own FMV, its own page. Top Shot expresses one as a
// `::subedition` with a `subedition_name`; Candy MLB expresses its Rainbow
// colour printings ONLY as an edition badge written by the Solana ingest
// ("Rainbow (Blue)", lib/chains/solana/normalize.ts). Until 2026-09-25 that
// badge reached no surface, so six Candy pages — Core + five colours — carried
// the identical title "Bobby Witt Jr. — 2026 MLB Base Series ICONs" and their
// related tiles were indistinguishable lines.
//
// This is the ONE place that knows which badge titles name a parallel. Keep it
// a registry: a new vocabulary is a new entry here, never a regex in a page.

const PARALLEL_BADGE_PATTERNS: readonly RegExp[] = [
  // Candy MLB Drop 1 — the five Rainbow colours (recon 2026-07-16).
  /^Rainbow \((?:Orange|Yellow|Green|Blue|Pink)\)$/,
]

/** The badge title that names this edition's parallel printing, or null. */
export function parallelLabelFromBadges(badges: readonly (string | null | undefined)[] | null | undefined): string | null {
  if (!badges) return null
  for (const b of badges) {
    if (typeof b !== "string") continue
    const t = b.trim()
    if (PARALLEL_BADGE_PATTERNS.some((re) => re.test(t))) return t
  }
  return null
}

/**
 * A board row's set line with its parallel named: "Base Set · Rippled" (2026-10-29). Top Shot
 * parallels are their own editions with their own #1, serials and prices, and the boards listed
 * them with the set name alone, so a Rippled /4000 read as the standard /4000 (first-mint: 254 of
 * 519 rows; squeeze: 4,782 of 14,502). Null set + null parallel is null; a lone parallel stands alone.
 */
export function setWithParallel(setName: string | null | undefined, parallel: string | null | undefined): string | null {
  const s = setName?.trim() || null
  const p = parallel?.trim() || null
  if (s && p) return `${s} · ${p}`
  return s ?? p
}
