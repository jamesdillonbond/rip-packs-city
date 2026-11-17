// lib/topshot/play-description.ts
//
// Normalizer for the Top Shot `play.stats.description` prose — the paragraph
// the moment page renders, and the ONLY narrative text anywhere in our catalog.
//
// Confirmed present and populated 2026-08-11 via
// /api/admin/discover-moment-descriptors, sample:
//
//   "Mike James has returned to make an impact at the NBA level. The Brooklyn
//    Nets guard drives hard along the baseline to leap way up for an elevated
//    three-pointer in his first game back. James finished with eight points in
//    the April 23, 2021 win over the Boston Celtics."
//
// This lives in lib/ rather than inline in the backfill route for the reason
// this codebase has settled on repeatedly: an `app/api/**/route.ts` body is
// measured by the primary coverage gate only as a whole, no route file here
// exports non-handler helpers, and the mapping rules below are exactly the kind
// of small pure logic that silently rots when it is untestable.
//
// ⚠ `headline` was probed in the same pass and is NOT ingested: its sample was
// just "Mike James" — the player name again, not the editorial title the moment
// page shows ("… stuffs stat sheet in historic 5x5 vs Lakers"). That title
// comes from somewhere else and has not been located. Do not add a `headline`
// column expecting the screenshot's text.
//
// ⚠ Sibling fields probed at the same time return SENTINELS, not nulls:
// `draftYear: 0`, `draftRound: "N/A"`, `quarter: "NA"`. Anything ingesting
// those must map the sentinel to null or the UI will render "Drafted 0".
// `isSentinel` below exists so that lesson is encoded rather than remembered.

/** Sentinel strings the Top Shot stats block uses in place of null. */
const SENTINEL_STRINGS = new Set(["na", "n/a", "none", "unknown", "-", "--"])

/**
 * True when an upstream stats value is a placeholder rather than real data.
 * Top Shot does not use null consistently — it returns "N/A" / "NA" / 0.
 */
export function isSentinel(value: unknown): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === "number") return value === 0
  if (typeof value === "string") {
    const t = value.trim().toLowerCase()
    return t === "" || SENTINEL_STRINGS.has(t)
  }
  return false
}

/**
 * Normalize a play description for storage in `editions.description`.
 *
 * Returns null — never an empty string — so "do we have prose for this
 * edition?" stays a plain `IS NOT NULL` test rather than needing a
 * `<> ''` companion that some future query will forget.
 *
 * Whitespace is collapsed because the upstream prose arrives with newlines and
 * doubled spaces from its CMS, and a trigram index over inconsistently spaced
 * text matches inconsistently.
 */
export function normalizePlayDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const collapsed = raw.replace(/\s+/g, " ").trim()
  if (!collapsed) return null
  // A description that is only a sentinel carries no information.
  if (SENTINEL_STRINGS.has(collapsed.toLowerCase())) return null
  return collapsed
}
