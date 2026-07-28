// lib/collection/server-moment.ts
//
// Pure mapping from a server-paginated wallet moment (the /api/wallet-* row
// shape) to the client MomentRow the collection page renders. Extracted
// verbatim from app/(collections)/[collection]/collection/page.tsx (monolith
// Phase-2 slice) so the numeric-coercion, cost-basis, and confidence→method
// edge cases are a standalone, unit-tested surface. The only value the original
// closed over was collectionObj?.sport; it is now an explicit `sport` param so
// this is a pure function.

import type { MomentRow } from "@/lib/collection/types"
import type { SerialFmvData } from "@/components/SerialFmvBadge"
import type { PriceBand30d } from "@/components/PriceBand30dBadge"

// The row shape returned by the server-paginated moments endpoints.
export type ServerMoment = {
  moment_id: string
  edition_key: string | null
  serial_number: number | null
  fmv_usd: number | null
  confidence: string | null
  low_ask: number | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  series_number: number | null
  circulation_count: number | null
  thumbnail_url: string | null
  team_name: string | null
  acquired_at: string | null
  last_seen_at: string | null
  buy_price: number | null
  acquisition_method: string | null
  acquisition_source: string | null
  acquisition_confidence: string | null
  loan_principal: number | null
  source_address: string | null
  is_locked: boolean
  serial_fmv?: SerialFmvData
  price_band_30d?: PriceBand30d
}

// Acquisition-method → short display label ("Bought" / "Pack" / …). null for
// methods that should show no label (e.g. unknown).
export const ACQUISITION_LABEL_MAP: Record<string, string | null> = {
  marketplace: "Bought",
  pack_pull: "Pack",
  loan_default: "Loan",
  gift: "Gift",
  challenge_reward: "Reward",
  airdrop: "Airdrop",
  unknown: null,
}

export function serverMomentToRow(m: ServerMoment, sport?: string | null): MomentRow {
  // Ensure fmv_usd is a real number (Supabase numeric cols can arrive as strings)
  const fmvNum = m.fmv_usd != null ? Number(m.fmv_usd) : null
  const fmvVal = (fmvNum != null && Number.isFinite(fmvNum) && fmvNum > 0) ? fmvNum : null
  const lowAskNum = m.low_ask != null ? Number(m.low_ask) : null
  const lowAskVal = (lowAskNum != null && Number.isFinite(lowAskNum) && lowAskNum > 0) ? lowAskNum : null

  // Derive cost basis from RPC acquisition fields
  const acqMethod = m.acquisition_method ?? null
  const label = acqMethod ? (ACQUISITION_LABEL_MAP[acqMethod] ?? null) : null
  let basis: number | null = null
  if (acqMethod === "marketplace" && m.buy_price != null) basis = Number(m.buy_price)
  else if (acqMethod === "loan_default" && m.loan_principal != null) basis = Number(m.loan_principal)

  // Map confidence to FMV method label
  const conf = m.confidence?.toUpperCase() ?? null
  const fmvMethodLabel: MomentRow["fmvMethod"] = conf === "HIGH" ? "band" : conf === "MEDIUM" ? "low-ask-only" : conf === "LOW" ? "best-offer-only" : "none"

  // Determine best market from low_ask (Top Shot floor)
  const bestMarketVal: MomentRow["bestMarket"] = lowAskVal ? "Top Shot" : null

  return {
    momentId: m.moment_id,
    playerName: m.player_name ?? "Unknown",
    team: m.team_name ?? undefined,
    league: sport ?? undefined,
    setName: m.set_name ?? "Unknown Set",
    editionKey: m.edition_key,
    fmv: fmvVal,
    serialNumber: m.serial_number ?? undefined,
    serial: m.serial_number ?? undefined,
    serialFmv: m.serial_fmv ?? null,
    priceBand30d: m.price_band_30d ?? null,
    mintCount: m.circulation_count ?? undefined,
    mintSize: m.circulation_count ?? undefined,
    tier: m.tier ? m.tier.replace(/^MOMENT_TIER_/i, "") : undefined,
    series: m.series_number != null ? String(m.series_number) : undefined,
    thumbnailUrl: m.thumbnail_url,
    acquiredAt: m.acquired_at ?? null,
    marketConfidence: (m.confidence?.toLowerCase() ?? "none") as MomentRow["marketConfidence"],
    fmvUsd: fmvVal,
    fmvMethod: fmvMethodLabel,
    lowAsk: lowAskVal,
    topshotAsk: lowAskVal,
    bestMarket: bestMarketVal,
    officialBadges: [],
    specialSerialTraits: [],
    isLocked: m.is_locked === true,
    bestAsk: lowAskVal,
    bestOffer: null,
    lastPurchasePrice: null,
    parallel: null,
    subedition: null,
    flowId: m.moment_id,
    acquisitionMethod: acqMethod,
    acquisitionSource: m.acquisition_source ?? null,
    acquisitionConfidence: m.acquisition_confidence ?? null,
    sourceAddress: m.source_address ?? null,
    loanPrincipal: m.loan_principal != null ? Number(m.loan_principal) : null,
    costBasis: basis,
    costBasisLabel: label,
  }
}
