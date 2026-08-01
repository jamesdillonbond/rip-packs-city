// lib/fmv-basis.ts
//
// ASK-DERIVED FMV DISCLOSURE (2026-08-01, Trevor-approved: "disclose basis,
// platform-wide").
//
// ~5,800 Flow editions plus ~730 Panini editions carry an FMV that is
// `0.90 x a single seller's ask` because the edition has no corroborating
// sales at all (see app/api/fmv-recalc/route.ts and
// lib/chains/panini/ingest-normalize.ts::toFmvRow). Those rows are stamped
// `confidence = 'ASK_ONLY'`. Until now nothing on any public surface
// distinguished them from a sale-derived FMV, so a board could render
// "FMV $450,009" for a card that has never traded -- 90% of one seller's
// asking price, presented in the same typeface as a number backed by real
// sales.
//
// THE STANDING POLICY IS UNCHANGED: never render the internal confidence
// vocabulary (HIGH / MEDIUM / LOW / STALE / ...) on a public surface. A visitor
// has no way to calibrate an enum they have never seen, so publishing it leaks
// implementation detail instead of informing anyone. The accepted precedent is
// /insights/deals, which relabelled its confidence pills to
// "FMV BASIS - Standard / Strict" -- plain words for the same control.
//
// This helper follows that precedent for the one case where the DIFFERENCE is
// material to a reader: an ask-derived price is not a market price. It returns
// a marker ONLY for ASK_ONLY. Everything else returns null, so the ~95% of
// values that ARE sale-derived stay unmarked -- absence of a marker is the
// default, and marking every row would drown the one that matters.
//
// DO NOT extend this to emit a per-tier label. That is the confidence UI the
// policy forbids, wearing a different hat.

export type FmvBasisMarker = {
  /** Short inline label, rendered next to the FMV value. Plain English. */
  label: string
  /** Tooltip / `title` text explaining what the number actually is. */
  title: string
}

const ASK_DERIVED: FmvBasisMarker = {
  label: "from asks",
  title:
    "Derived from the lowest listed ask, not a completed sale. This edition has no corroborating sales, so the price is what one seller is asking - check recent sales before acting on it.",
}

/**
 * Marker for an FMV value, keyed off its `fmv_snapshots.confidence`
 * (or `panini_fmv_snapshots.confidence`) value.
 *
 * Returns a marker ONLY for ask-derived (`ASK_ONLY`) prices; `null` for every
 * other confidence -- including null/unknown, so a surface that has not fetched
 * confidence degrades to "no marker" rather than to a wrong claim.
 */
export function fmvBasis(confidence: string | null | undefined): FmvBasisMarker | null {
  if (!confidence) return null
  return String(confidence).trim().toUpperCase() === "ASK_ONLY" ? ASK_DERIVED : null
}

/** True when this FMV is 0.9 x a single ask rather than a sale-derived price. */
export function isAskDerivedFmv(confidence: string | null | undefined): boolean {
  return fmvBasis(confidence) != null
}
