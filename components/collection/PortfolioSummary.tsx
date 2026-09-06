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
  computeLoanDefaults,
  computeCostBasisSummary,
} from "@/lib/portfolio-summary-compute"

type WalletSummary = {
  wallet_fmv: number
  unlocked_fmv: number
  unlocked_count: number
  locked_fmv: number
  locked_count: number
  cost_basis: number
  current_fmv: number
  pnl: number
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
            bestOfferTotal,
            spreadGap,
            momentCount,
            staleFmv,
            staleCount,
            staleUnknown,
          } = computeWalletStatRow({ walletSummary, walletTotalFmv, totals, paginatedTotal, collectionSlug })
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
              spreadGap={spreadGap}
              staleFmv={staleFmv}
              staleCount={staleCount}
              staleUnknown={staleUnknown}
              collectionSlug={collectionSlug}
              loading={walletSummaryLoading}
              walletFmvAccessory={
                <ExplainButton
                  context={`Wallet ${connectedWallet || ownerKey || input.trim()} on ${collectionSlug}`}
                  question="How is my total portfolio FMV calculated?"
                />
              }
            />

            {acquisitionStats && acquisitionStats.total_count > 0 && (
              <div className="grid grid-cols-3 gap-3 rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3 font-mono">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">From Packs</span>
                  <span className="text-lg font-black" style={{ color: "rgb(20,184,166)" }}>{acquisitionStats.pack_pull_count.toLocaleString()}</span>
                </div>
                <div className="flex flex-col border-l border-[color:var(--rpc-border)] pl-3">
                  <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">From Market</span>
                  <span className="text-lg font-black text-[color:var(--rpc-text-secondary)]">{acquisitionStats.marketplace_count.toLocaleString()}</span>
                </div>
                <div className="flex flex-col border-l border-[color:var(--rpc-border)] pl-3">
                  <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Rewards</span>
                  <span className="text-lg font-black" style={{ color: "rgb(245,158,11)" }}>{acquisitionStats.challenge_reward_count.toLocaleString()}</span>
                </div>
              </div>
            )}

            {(function() {
              const loans = computeLoanDefaults(rows)
              if (!loans) return null
              const { count: loanCount, totalPrincipal: total } = loans
              return (
                <div
                  className="rounded-lg border px-3 py-2 text-xs font-mono flex items-center gap-2"
                  style={{ borderColor: "rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.06)", color: "#fca5a5" }}
                  title="Acquired via loan default. Principal is the USDCF value lent against these moments (1:1 USD)."
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M14 11l7-7M9 7l7 7M3 21l4-4M9 11l4 4M14 4l6 6M3 13l8 8" />
                  </svg>
                  <span>
                    {loanCount.toLocaleString()} acquired via loan default ({"$" + total.toFixed(2)} principal)
                  </span>
                </div>
              )
            })()}
          </div>
          )
        })()}

        {/* Cost basis / P&L summary — suppressed on closed markets, where a
             "Current FMV" / P&L figure would assert a live valuation that no
             longer exists (WalletStatRow already shows the count + closure note). */}
        {hasSearched && !isMarketClosed(collectionSlug) && (walletSummary?.cost_basis ? walletSummary.cost_basis > 0 : (costBasis.size > 0 || rows.some(function(r) { return r.costBasis != null }))) && (function() {
          const summary = computeCostBasisSummary(walletSummary, rows, costBasis)
          if (!summary) return null
          const { totalCost, totalFmv, totalPl, plPct, count, walletWide } = summary
          const plColor = totalPl >= 0 ? "text-emerald-400" : "text-red-400"
          return (
            <div className="flex flex-wrap gap-6 items-center mb-4 p-3 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-sm font-mono">
              <div><span className="text-[color:var(--rpc-text-muted)]">Cost Basis:</span> <span className="text-[color:var(--rpc-text-primary)]">${totalCost.toFixed(2)}</span></div>
              <div><span className="text-[color:var(--rpc-text-muted)]">Current FMV:</span> <span className="text-[color:var(--rpc-text-primary)]">${totalFmv.toFixed(2)}</span></div>
              <div><span className="text-[color:var(--rpc-text-muted)]">P&amp;L:</span> <span className={plColor}>{totalPl >= 0 ? "+" : ""}{totalPl.toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(0)}%)</span></div>
              {walletWide
                ? <div className="text-[color:var(--rpc-text-muted)] text-xs">wallet-wide totals</div>
                : <div className="text-[color:var(--rpc-text-muted)] text-xs">{count} moments with cost data</div>}
            </div>
          )
        })()}

        {/* Close to Completing callout */}
        {nearCompleteSets.length > 0 && hasSearched && (
          <div style={{ borderLeft: "3px solid #22c55e", background: "var(--rpc-surface)", borderRadius: 6, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "#22c55e", letterSpacing: "0.1em", marginBottom: 4 }}>◉ CLOSE TO COMPLETING</div>
            <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#a1a1aa" }}>
              {nearCompleteSets.map(function(s: any, i: number) {
                return (
                  <span key={s.setId ?? s.setName}>
                    {i > 0 && " · "}
                    <a href={"/nba-top-shot/sets"} style={{ color: "#a1a1aa", textDecoration: "none" }}>
                      {s.setName} — {s.missingCount} away{s.totalMissingCost != null ? " · $" + s.totalMissingCost.toFixed(2) : ""}
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
