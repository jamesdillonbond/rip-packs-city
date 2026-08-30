// Shared types for the wallet-collection viewer
// (app/(collections)/[collection]/collection/page.tsx). Extracted verbatim in
// the Phase 1 structural refactor — behavior-preserving, no logic change.
import type { SerialFmvData } from "@/components/SerialFmvBadge"
import type { PriceBand30d } from "@/components/PriceBand30dBadge"

export type BadgeInfo = {
  badge_score: number
  badge_titles: string[]
  is_three_star_rookie: boolean
  has_rookie_mint: boolean
  burn_rate_pct: number | null
  lock_rate_pct: number | null
  low_ask: number | null
  circulation_count: number | null
  effective_supply: number | null
  burned: number
  owned: number
  hidden_in_packs: number
  for_sale_by_collectors: number | null
}

export type MomentRow = {
  momentId: string
  playerName: string
  team?: string
  league?: string
  setName: string
  series?: string
  tier?: string
  serialNumber?: number
  serial?: number
  mintCount?: number
  mintSize?: number
  jerseyNumber?: number | null
  officialBadges?: string[]
  specialSerialTraits?: string[]
  traits?: string[]
  isLocked?: boolean
  locked?: boolean
  bestAsk?: number | null
  lowAsk?: number | null
  topshotAsk?: number | null
  flowtyAsk?: number | null
  bestMarket?: "Top Shot" | "Flowty" | null
  bestOffer?: number | null
  lastPurchasePrice?: number | null
  acquiredAt?: string | null
  editionKey?: string | null
  parallel?: string | null
  subedition?: string | null
  editionsOwned?: number
  editionsLocked?: number
  thumbnailUrl?: string | null
  flowId?: string | null
  flowtyListingUrl?: string | null
  fmv?: number | null
  valuationScope?: "Parallel" | "Edition" | "Modeled"
  marketDebugReason?: string
  marketSource?: "row" | "edition" | "row+edition" | "edition-sale" | "special-serial" | "none"
  fmvMethod?: "band" | "low-ask-only" | "best-offer-only" | "edition-last-sale" | "special-serial-premium" | "none"
  marketConfidence?: "high" | "medium" | "low" | "stale" | "ask_only" | "sales_only" | "no_data" | "none"
  scopeKey?: string
  rowLowAsk?: number | null
  rowBestOffer?: number | null
  editionLowAsk?: number | null
  editionBestOffer?: number | null
  editionLastSale?: number | null
  editionAskCount?: number
  editionOfferCount?: number
  editionSaleCount?: number
  editionMarketSource?: string | null
  editionMarketSourceChain?: string[]
  editionMarketTags?: string[]
  fmvComputedAt?: string | null
  fmvUsd?: number | null
  tssPoints?: number | null
  badgeInfo?: BadgeInfo | null
  editionOffer?: number | null
  bestOfferType?: "edition" | "serial" | null
  /**
   * Hours since the winning bid was last CONFIRMED, computed server-side by
   * /api/best-offers so no client clock is read during render. `null`/absent means
   * UNKNOWN — two of the four offer legs carry no confirmation timestamp at all — and
   * unknown must render as NO marker, never as fresh.
   */
  bestOfferAgeHours?: number | null
  acquisitionMethod?: string | null
  acquisitionSource?: string | null
  acquisitionConfidence?: string | null
  sourceAddress?: string | null
  loanPrincipal?: number | null
  buyPrice?: number | null
  costBasis?: number | null
  costBasisLabel?: string | null
  serialFmv?: SerialFmvData
  priceBand30d?: PriceBand30d
}

export type WalletSearchResponse = {
  rows?: MomentRow[]
  summary?: { totalMoments: number; returnedMoments: number; remainingMoments: number }
  error?: string
}

export type CollectionSeriesEntry = {
  series_number: number
  display_label: string
  season: string | null
}

export type SortKey = "player" | "series" | "set" | "parallel" | "rarity" | "serial" | "fmv" | "bestOffer" | "held" | "badge" | "acquired" | "paid"
