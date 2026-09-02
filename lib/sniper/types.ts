// lib/sniper/types.ts
//
// Shared types for the collection sniper page, extracted verbatim in the
// Phase 1 structural refactor of app/(collections)/[collection]/sniper/page.tsx.
// Behavior-identical — no field or shape changes.

export interface SniperDeal {
  flowId: string;
  momentId: string;
  editionKey: string;
  intEditionKey?: string | null;
  playerName: string;
  teamName: string;
  setName: string;
  seriesName: string;
  tier: string;
  parallel: string;
  parallelId: number;
  serial: number;
  circulationCount: number;
  askPrice: number;
  baseFmv: number;
  adjustedFmv: number;
  aspUsd: number | null;
  daysSinceSale: number | null;
  salesCount30d: number | null;
  discount: number;
  confidence: string;
  confidenceSource?: string;
  hasBadge: boolean;
  badgeSlugs: string[];
  badgeLabels: string[];
  badgePremiumPct: number;
  serialMult: number;
  isSpecialSerial: boolean;
  isJersey: boolean;
  serialSignal: string | null;
  thumbnailUrl: string | null;
  isLocked: boolean;
  updatedAt: string | null;
  packListingId: string | null;
  packName: string | null;
  packEv: number | null;
  packEvRatio: number | null;
  buyUrl: string;
  listingResourceID: string | null;
  storefrontAddress: string | null;
  source?: "topshot" | "allday" | "golazos" | "pinnacle" | "flowty";
  paymentToken?: "DUC" | "FUT" | "FLOW" | "USDC_E";
  offerAmount?: number | null;
  offerFmvPct?: number | null;
  dealRating?: number;
  isLowestAsk?: boolean;
  // P1a: FMV is thin/uncertain or was clamped to the 90d max sale — show a
  // caveat instead of headlining the discount (Top Shot only).
  lowConfidenceFmv?: boolean;
  // Fee-net math (lib/marketplace-fees.ts). Every other price on a deal is
  // GROSS; the marketplace takes its cut out of the SELLER's proceeds, so the
  // headline discount overstates what a flip is worth. netMarginPct is measured
  // against the ASK — the money at risk. Null when the collection has no
  // VERIFIED published rate. Additive only: never feeds discount or ranking.
  netOfFees?: {
    feePct: number;
    netIfResold: number;
    netMarginUsd: number;
    netMarginPct: number;
    flipsNegative: boolean;
  } | null;
  // Phase 2 serial-adjusted FMV (validated #1/perfect premium; additive guide).
  serialFmvEstimate?: {
    estimate_usd: number;
    multiplier: number;
    serial_bucket: "first" | "perfect";
    label: string;
  } | null;
}

export interface FeedResult {
  count: number;
  tsCount?: number;
  flowtyCount?: number;
  lastRefreshed: string;
  deals: SniperDeal[];
  cached?: boolean;
  /**
   * Deal-bearing reads that FAILED on this build (internal source labels, not
   * UI copy). Empty means every source answered, so an empty `deals` is a
   * genuine "nothing matched" — the only case the UI may say so in.
   * See lib/sniper/source-failures.ts.
   */
  sourcesFailed?: string[];
  /** `sourcesFailed.length > 0`. Sent by the route so clients need not derive it. */
  degraded?: boolean;
}

export type SortOption =
  | "discount"
  | "price_asc"
  | "price_desc"
  | "fmv_desc"
  | "serial_asc"
  | "listed_desc";
