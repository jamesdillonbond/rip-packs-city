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

// #215 (2026-10-29): an ASK_ONLY price can be CAPPED at the edition's own sales (#208's
// `_salescap`, the 10-29 `_histcap`). The label stays ASK_ONLY by decision, but "from asks — no
// corroborating sales" then states the opposite of the number: $114 on an $8,000 ask is the
// edition's sales talking, not the seller. A surface that knows the row was capped (the
// `basis_capped` flag) says so instead.
const CAPPED_AT_SALES: FmvBasisMarker = {
  label: "capped at sales",
  title:
    "The lowest listed ask is higher than this edition has sold for, so the price is held to its own sales rather than taken from the ask.",
}

/**
 * Marker for an FMV value, keyed off its `fmv_snapshots.confidence`
 * (or `panini_fmv_snapshots.confidence`) value.
 *
 * Returns a marker ONLY for ask-derived (`ASK_ONLY`) prices; `null` for every
 * other confidence -- including null/unknown, so a surface that has not fetched
 * confidence degrades to "no marker" rather than to a wrong claim. `capped` (the
 * payload's `basis_capped`) swaps "from asks" for "capped at sales"; a surface that
 * does not carry the flag keeps the ask marker (#215 tracks those).
 */
export function fmvBasis(confidence: string | null | undefined, capped?: boolean | null): FmvBasisMarker | null {
  if (!confidence) return null
  if (String(confidence).trim().toUpperCase() !== "ASK_ONLY") return null
  return capped === true ? CAPPED_AT_SALES : ASK_DERIVED
}

/**
 * True when an FMV row's `algo_version` marks it CAPPED at the edition's own sales (#208's
 * `_salescap`, the 10-29 `_histcap`). The SQL twin is `get_edition_detail`'s `basis_capped`
 * (`algo_version ~ '_(salescap|histcap)$'`); null/unknown reads false (no claim).
 */
export function isSalesCappedAlgo(algoVersion: string | null | undefined): boolean {
  return typeof algoVersion === "string" && /_(salescap|histcap)$/.test(algoVersion)
}

/** True when this FMV is ASK_ONLY (its floor field is an ask, not a sale) — capped or not. */
export function isAskDerivedFmv(confidence: string | null | undefined): boolean {
  return fmvBasis(confidence) != null
}
