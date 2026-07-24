// grail-format — pure formatting/threshold/probability logic lifted out of
// components/packs/GrailsView.tsx so it lands under the vitest coverage
// `include` (lib/**), which does NOT measure components/**. No React/JSX, no
// browser globals — behavior is identical to the inline code it replaced.

// Tier → accent color for the chase-moment border / stat pills. Substring match
// (case-insensitive) so "legendary_common" style compound labels still resolve;
// unknown tiers fall back to the neutral gray.
export function tierColor(tier: string | null | undefined): string {
  const t = (tier || '').toLowerCase()
  if (t.includes('ultimate')) return '#EC4899'
  if (t.includes('legendary')) return '#F59E0B'
  if (t.includes('rare')) return '#818CF8'
  if (t.includes('fandom')) return '#34D399'
  if (t.includes('common')) return '#9CA3AF'
  if (t.includes('premium')) return '#A855F7'
  if (t.includes('standard')) return '#6B7280'
  return '#6B7280'
}

// USD display: em-dash for null/non-finite, whole-dollar with thousands
// separators at/above $1,000, otherwise 2 decimals.
export function fmtUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—'
  const v = Number(n)
  if (Math.abs(v) >= 1000) return '$' + Math.round(v).toLocaleString('en-US')
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

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
