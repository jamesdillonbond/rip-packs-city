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
