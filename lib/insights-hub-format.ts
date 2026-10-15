// Pure display helpers for the public /insights hub (app/insights/page.tsx).
//
// Extracted verbatim from the server page so the branch logic — the per-card
// live-stat sentence and the compact USD band — is measured + unit-tested. The
// hub renders `liveStat(card.slug, stats.insights)` under each card; a wrong or
// crashing branch here silently drops (or misstates) a card's headline number on
// the highest-traffic public surface. The page keeps its own HubStats type and
// imports these; HubStats["insights"] is structurally this shape.

import { usdSignFirst } from "@/lib/usd-format"

export interface HubInsightStats {
  squeezeEditions: number
  setSqueezeSets: number
  pinnacleEditions: number
  packZeroPct: number
  packRips60d: number
  rookieGmv30d: number
  rookieCount: number
  firstMintAvg: number
  firstMintMax: number
  crossCohort: number
}

export function fmtUsd(n: number): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (!Number.isFinite(n)) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`
  return `$${Math.round(n)}`
}

export function liveStat(slug: string | null, s: HubInsightStats): string | null {
  switch (slug) {
    case "/insights/squeeze":
      return `${s.squeezeEditions.toLocaleString()} editions ≥50% squeezed`
    case "/insights/pack-reality":
      // 2026-10-14: "11% of rips pull $0" was 7,012 UNPRICED rips counted as
      // zeros (0 real $0 pulls). The share is now real, and a 0 says nothing
      // worth a card, so the card names the audit size instead.
      return s.packZeroPct > 0
        ? `${s.packZeroPct}% of rips pull $0 · ${s.packRips60d.toLocaleString()} rips/60d`
        : `${s.packRips60d.toLocaleString()} rips audited/60d`
    case "/insights/rookies":
      return `${fmtUsd(s.rookieGmv30d)} GMV/30d · ${s.rookieCount} rookies`
    case "/insights/first-mint":
      return `avg ${s.firstMintAvg}× · max ${s.firstMintMax}×`
    case "/insights/cross-collection":
      return `${s.crossCohort} wallets hold 3+ collections`
    case "/insights/set-squeeze":
      return `${s.setSqueezeSets} sets ranked`
    case "/insights/pinnacle-scarcity":
      return `${s.pinnacleEditions} editions ranked`
    default:
      return null
  }
}
