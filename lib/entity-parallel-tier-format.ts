// lib/entity-parallel-tier-format.ts
//
// Pure premium-multiple / label / threshold logic lifted out of
// components/entity/ParallelTierSwitcher.tsx so it lands under the coverage
// ratchet (vitest `include` is lib/** + app/api/**/route.ts only — component
// bodies are invisible). Behavior is identical to the inline versions; the
// component imports these and renders unchanged.
//
// A regression here mis-computes the parallel-printing premium vs Standard,
// mislabels a pill, or wrongly shows/hides the premium chip and the
// compare-all drill-in.

// Premium multiples at or above this render (near-parity printings stay clean).
export const PREMIUM_MIN_MULT = 1.3

/** Fields needed to compute a printing's premium vs Standard. */
export interface PremiumSibling {
  subedition_name: string | null
  fmv_usd: number | null
}

/** Fields needed to derive a pill's display name. */
export interface NameSibling {
  external_id: string
  subedition_id: number | null
  subedition_name: string | null
}

/**
 * Format a premium multiple: 10× and above → whole-number with grouping
 * ("1,200×"); below 10 → one decimal ("3.4×").
 */
export function fmtMult(n: number): string {
  return n >= 10 ? `${Math.round(n).toLocaleString("en-US")}×` : `${n.toFixed(1)}×`
}

/**
 * The Standard printing's FMV — the denominator for every parallel premium.
 * Standard is the sibling with no subedition_name. Returns null when absent or
 * unpriced.
 */
export function siblingBaseFmv(siblings: PremiumSibling[]): number | null {
  const standard = siblings.find((s) => !s.subedition_name)
  return standard?.fmv_usd ?? null
}

/**
 * Premium multiple of a parallel printing vs Standard (parallel FMV / Standard
 * FMV). Only defined for a priced non-Standard printing against a positive
 * Standard FMV; otherwise null.
 */
export function premiumMultiple(sibling: PremiumSibling, baseFmv: number | null): number | null {
  return baseFmv && baseFmv > 0 && sibling.fmv_usd != null && sibling.subedition_name
    ? sibling.fmv_usd / baseFmv
    : null
}

/**
 * Whether a premium chip should render for a given multiple. Type-guards to
 * `number` so callers can format the value without re-checking for null.
 */
export function isPremiumShown(mult: number | null): mult is number {
  return mult != null && mult >= PREMIUM_MIN_MULT
}

/**
 * Whether any sibling clears the premium threshold — gates the "compare all
 * parallel premiums" drill-in link.
 */
export function hasAnyPremium(siblings: PremiumSibling[]): boolean {
  const baseFmv = siblingBaseFmv(siblings)
  return siblings.some((s) => isPremiumShown(premiumMultiple(s, baseFmv)))
}

/**
 * Pill display name for a printing: the subedition_name if present; otherwise
 * "Parallel #<id>" for a parallel edition key (contains "::"), else "Standard".
 */
export function pillName(sibling: NameSibling): string {
  if (sibling.subedition_name) return sibling.subedition_name
  return sibling.external_id.includes("::") ? `Parallel #${sibling.subedition_id ?? "?"}` : "Standard"
}
