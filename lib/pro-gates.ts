// lib/pro-gates.ts
// Feature gating config for RPC Pro. Truthy = requires Pro.
// Infrastructure-only — enforcement (upgrade prompts) lands in a follow-up.

export const PRO_FEATURES = {
  // Free for everyone
  collection_basic: false,
  sniper_basic: false,
  badges_view: false,
  sets_view: false,
  concierge_basic: false,

  // Pro only
  price_alerts: true,
  portfolio_export: true,
  cross_collection_deals: true,
  advanced_analytics: true,
  concierge_unlimited: true,
  weekly_digest: true,
  portfolio_pnl: true,
} as const

export type ProFeature = keyof typeof PRO_FEATURES

export function requiresPro(feature: ProFeature): boolean {
  return PRO_FEATURES[feature]
}
