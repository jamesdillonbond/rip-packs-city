"use client"

// Portfolio summary stack (WalletStatRow adapter + acquisition tiles + loan
// callout + cost-basis/P&L + close-to-completing) for the wallet-collection
// viewer. Pure display — read-only props, no setters/handlers. Extracted
// VERBATIM from collection/page.tsx in the Phase 2 refactor (behavior-preserving).
import ExplainButton from "@/components/ExplainButton"
import WalletStatRow from "@/components/wallet-stat-row"
import { isMarketClosed } from "@/lib/market-closed"
import type { MomentRow } from "@/lib/collection/types"
import {
  computeWalletStatRow,
  computeCostBasisSummary,
} from "@/lib/portfolio-summary-compute"
import { usdSignFirst } from "@/lib/usd-format"

// 2026-09-24: the P&L strip printed "$113124.59" (no separators) and called a
// cost-basis subset "wallet-wide totals" while its Current FMV ($34k) sat
// beside a Wallet FMV of $58k. Format with separators; say what the subset is.
export function fmtUsd2(n: number): string {
  const neg = usdSignFirst(n, fmtUsd2); if (neg !== null) return neg
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// The near-complete callout's cost. An unknown cost (no ask, no FMV on the
// missing plays) rendered as "$0.00" — a fabricated zero in the honesty class.
// null → "unpriced"; a partially priced set is a lower bound.
export function nearCompleteCostLabel(s: {
  totalMissingCost?: number | null
  unpricedMissingCount?: number | null
}): string {
  if (s.totalMissingCost == null) return " · unpriced"
  const unpriced = s.unpricedMissingCount ?? 0
  if (unpriced > 0) return ` · ≥ ${fmtUsd2(s.totalMissingCost)} (${unpriced} unpriced)`
  return ` · ${fmtUsd2(s.totalMissingCost)}`
}

type WalletSummary = {
  wallet_fmv: number
  unlocked_fmv: number
  unlocked_count: number
  locked_fmv: number
  locked_count: number
  cost_basis: number
  current_fmv: number
  pnl: number
  moments_with_cost?: number
  stale_with_cost_count?: number
  lock_unknown_fmv?: number
  lock_unknown_count?: number
} | null

type AcquisitionStats = {
  pack_pull_count: number
  marketplace_count: number
  challenge_reward_count: number
  gift_count: number
  total_count: number
  locked_count: number
  total_spent: number
} | null

type CostBasisEntry = {
  buyPrice: number
  acquiredDate: string
  fmvAtAcquisition: number | null
  acquisitionMethod: string | null
  costBasisLabel: string | null
}

type Totals = {
  totalFmv: number
  totalBestOffer: number
  offerCount?: number
  fmvWithOffer?: number
  pairedOffer?: number
  lockedFmv: number
  unlockedFmv: number
  totalCount: number
  lockedCount: number
  unlockedCount: number
  spreadGap: number
  badgeCount: number
  confHigh: number
  confMedium: number
  confLow: number
  confNone: number
}

type PortfolioSummaryProps = {
  hasSearched: boolean
  walletSummary: WalletSummary
  walletTotalFmv: number | null
  totals: Totals
  paginatedTotal: number
  walletSummaryLoading: boolean
  acquisitionStats: AcquisitionStats
  rows: MomentRow[]
  costBasis: Map<string, CostBasisEntry>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nearCompleteSets: any[]
  collectionSlug: string
  connectedWallet: string | null
  ownerKey: string
  input: string
}

export default function PortfolioSummary(props: PortfolioSummaryProps) {
  const {
    hasSearched,
    walletSummary,
    walletTotalFmv,
    totals,
    paginatedTotal,
    walletSummaryLoading,
    acquisitionStats,
    rows,
    costBasis,
    nearCompleteSets,
    collectionSlug,
    connectedWallet,
    ownerKey,
    input,
  } = props
  return (
    <>
        {/* Portfolio summary — always render once searched so empty/no-data wallets
             show $0 / em-dash placeholders rather than a missing tile row.
             Adapter logic: prefer authoritative walletSummary when loaded;
             fall back to client-computed totals; emit null (not 0) when the
             data hasn't arrived yet so WalletStatRow renders em-dash. */}
        {hasSearched && (function() {
          // Adapter logic (WalletStatRow inputs) extracted to
          // lib/portfolio-summary-compute — the All Day lock-suppression and the
          // walletSummary→totals→null fallback rules live there now.
          const {
            walletFmv,
            unlockedFmv,
            unlockedCount,
            lockedFmv,
            lockedCount,
            lockUnknownFmv,
            lockUnknownCount,
            bestOfferTotal,
            bestOfferCount,
            bestOfferUnit,
            spreadGap,
            momentCount,
            staleFmv,
            staleCount,
            staleUnknown,
            staleNetted,
          } = computeWalletStatRow({ walletSummary, walletTotalFmv, totals, paginatedTotal, collectionSlug })
          // 2026-11-24 (Trevor, "very simple and digestible, no subtext"): the cost-basis strip and the
          // three acquisition tiles fold into the hero as one Profit / Loss stat and one source bar.
          // P&L shows only when it is the WHOLE wallet's (get_wallet_summary) — a loaded page's sum
          // needed a caveat to be honest, and a caveat is the subtext being removed, so it waits.
          const cbs = !isMarketClosed(collectionSlug) && walletSummary && walletSummary.cost_basis > 0
            ? computeCostBasisSummary(walletSummary, rows, costBasis, paginatedTotal)
            : null
          const pnl = cbs && cbs.walletWide ? { amount: cbs.totalPl, pct: cbs.plPct } : null
          const acquisition = acquisitionStats && acquisitionStats.total_count > 0
            ? {
                packs: acquisitionStats.pack_pull_count,
                market: acquisitionStats.marketplace_count,
                rewards: acquisitionStats.challenge_reward_count,
                total: acquisitionStats.total_count,
              }
            : null
          return (
          <div className="mb-5 space-y-3">
            <WalletStatRow
              walletFmv={walletFmv}
              unlockedFmv={unlockedFmv}
              lockedFmv={lockedFmv}
              bestOfferTotal={bestOfferTotal}
              momentCount={momentCount}
              unlockedCount={unlockedCount}
              lockedCount={lockedCount}
              lockUnknownFmv={lockUnknownFmv}
              lockUnknownCount={lockUnknownCount}
              spreadGap={spreadGap}
              bestOfferCount={bestOfferCount}
              bestOfferUnit={bestOfferUnit}
              staleNetted={staleNetted}
              staleFmv={staleFmv}
              staleCount={staleCount}
              staleUnknown={staleUnknown}
              collectionSlug={collectionSlug}
              loading={walletSummaryLoading}
              pnl={pnl}
              acquisition={acquisition}
              walletFmvAccessory={
                <ExplainButton
                  context={`Wallet ${connectedWallet || ownerKey || input.trim()} on ${collectionSlug}`}
                  question="How is my total portfolio FMV calculated?"
                />
              }
            />

            {/* 2026-11-14 (Trevor): the loan-default callout is gone. It counted only the LOADED rows
                ("1 acquired via loan default" on a wallet holding 12), and the principal already enters
                Cost Basis as the moment's buy price (moment_acquisitions.buy_price = loan_principal). */}
          </div>
          )
        })()}

        {/* Close to Completing — 2026-11-24 restyle: one chip per set (was a 10px grey run-on line). */}
        {nearCompleteSets.length > 0 && hasSearched && (
          <div className="rpc-binder-near" data-testid="binder-near-complete">
            <div className="rpc-binder-near-label">◉ CLOSE TO COMPLETING</div>
            <div className="rpc-binder-near-chips">
              {nearCompleteSets.map(function(s: any, i: number) {
                return (
                  <span key={s.setId ?? s.setName}>
                    {i > 0 && <span className="sr-only"> · </span>}
                    {/* The collection's own Sets tab (was hardcoded to Top Shot; All Day and Pinnacle feed
                        this callout since 2026-10-26). */}
                    <a href={"/" + collectionSlug + "/sets"} className="rpc-binder-near-chip">
                      {/* All Day's tracker sums FMV, not asks — no dollar figure rather than a cost it is not (2026-10-26). */}
                      <strong>{s.setName}</strong> — {s.missingCount} away{collectionSlug === "nfl-all-day" ? "" : nearCompleteCostLabel(s)}
                    </a>
                  </span>
                )
              })}
            </div>
          </div>
        )}
    </>
  )
}
