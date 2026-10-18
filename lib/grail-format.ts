// grail-format — pure formatting/threshold/probability logic lifted out of
// components/packs/GrailsView.tsx so it lands under the vitest coverage
// `include` (lib/**), which does NOT measure components/**. No React/JSX, no
// browser globals — behavior is identical to the inline code it replaced.

// Tier → accent color for the chase-moment border / stat pills. Substring match
// (case-insensitive) so "legendary_common" style compound labels still resolve;
// unknown tiers fall back to the neutral gray.

import { NEUTRAL_TIER_COLOR } from '@/lib/tier-color'

export function tierColor(tier: string | null | undefined): string {
  const t = (tier || '').toLowerCase()
  if (t.includes('ultimate')) return 'var(--tier-ultimate)'
  if (t.includes('legendary')) return 'var(--tier-legendary)'
  if (t.includes('rare')) return 'var(--tier-rare)'
  if (t.includes('fandom')) return 'var(--tier-fandom)'
  if (t.includes('common')) return 'var(--tier-common)'
  if (t.includes('premium')) return 'var(--col-disney-pinnacle)'
  if (t.includes('standard')) return NEUTRAL_TIER_COLOR
  return NEUTRAL_TIER_COLOR
}

// USD display: em-dash for null/non-finite, whole-dollar with thousands
// separators at/above $1,000, otherwise 2 decimals. Consolidated 2026-08-01 —
// this body was byte-identical (modulo quote style) to lib/pack-simulator-math
// and one `$0` branch away from lib/dashboard/format; all three now share
// lib/usd-format.fmtUsdWhole1000. Output is unchanged.
export { fmtUsdWhole1000 as fmtUsd } from '@/lib/usd-format'

// Probability (0..1 fraction) → percentage string: 2 decimals under 1%, else 1.
export function fmtPct(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(Number(p))) return '—'
  const v = Number(p) * 100
  return v.toFixed(v < 1 ? 2 : 1) + '%'
}

// An FMV-threshold probability (P($100+) etc.) from pack_grail_metrics counts an
// edition with NO FMV as "not a grail", so it is a LOWER BOUND whenever pool FMV
// coverage is under 100 %, and says nothing at all when no pullable edition is
// priced (measured 2026-10-18: 435 of 5,478 dists partial, 267 at zero coverage).
// Tier probabilities (Ultimate/Legendary) are unaffected — tier needs no FMV.
export type FmvProbQualifier = 'exact' | 'lower' | 'none'
export function fmvProbQualifier(
  coveragePct: number | null | undefined,
  editionsWithFmv: number | null | undefined,
): FmvProbQualifier {
  if (editionsWithFmv != null && Number(editionsWithFmv) === 0) return 'none'
  if (coveragePct == null || !Number.isFinite(Number(coveragePct))) return 'lower'
  return Number(coveragePct) < 100 ? 'lower' : 'exact'
}

/** fmtPct for an FMV-threshold probability: "≥ x%" below full coverage, "—" with none. */
export function fmtFmvProb(p: number | null | undefined, q: FmvProbQualifier): string {
  if (q === 'none') return '—'
  const s = fmtPct(p)
  return q === 'lower' && s !== '—' ? `≥ ${s}` : s
}

// P(at least one in N draws) = 1 - (1 - p)^N — independent slot assumption
// matches the surface-level math in the simulator. Null/non-finite per-slot
// probability → null (unknown); clamps p to [0,1] before the geometric math.
export function atLeastOnce(p: number | null | undefined, slots: number): number | null {
  if (p == null || !Number.isFinite(Number(p))) return null
  const x = Number(p)
  if (x <= 0) return 0
  if (x >= 1) return 1
  return 1 - Math.pow(1 - x, slots)
}

// Pack price selection for the grail card: prefer the primary drop price, fall
// back to the secondary ask, else no price. Returns the chosen value plus the
// label the card shows above it ("PRIMARY" / "SECONDARY" / null when neither).
export function selectPackPrice(
  primaryPrice: number | null | undefined,
  secondaryAsk: number | null | undefined,
): { price: number | null; priceLabel: 'PRIMARY' | 'SECONDARY' | null } {
  const price = primaryPrice ?? secondaryAsk ?? null
  const priceLabel: 'PRIMARY' | 'SECONDARY' | null =
    primaryPrice != null ? 'PRIMARY' : secondaryAsk != null ? 'SECONDARY' : null
  return { price, priceLabel }
}
