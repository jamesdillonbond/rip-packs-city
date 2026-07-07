"use client"

// Portfolio summary stack (WalletStatRow adapter + acquisition tiles + loan
// callout + cost-basis/P&L + close-to-completing) for the wallet-collection
// viewer. Pure display — read-only props, no setters/handlers. Extracted
// VERBATIM from collection/page.tsx in the Phase 2 refactor (behavior-preserving).
import ExplainButton from "@/components/ExplainButton"
import WalletStatRow from "@/components/wallet-stat-row"
import type { MomentRow } from "@/lib/collection/types"

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
          const walletFmv: number | null = walletSummary
            ? walletSummary.wallet_fmv
            : (walletTotalFmv !== null && walletTotalFmv > 0
                ? walletTotalFmv
                : (totals.totalFmv > 0 ? totals.totalFmv : null))
          const unlockedFmv: number | null = walletSummary
            ? walletSummary.unlocked_fmv
            : (totals.totalCount > 0 ? totals.unlockedFmv : null)
          const unlockedCount: number | null = walletSummary
            ? walletSummary.unlocked_count
            : (totals.totalCount > 0 ? totals.unlockedCount : null)
          // Top Shot / AllDay / Golazos / UFC all support locking — pass 0
          // (not null) when there are no locked moments, since 0 means
          // "wallet has none locked" while null would mean "concept doesn't apply".
          const lockedFmv: number | null = walletSummary
            ? walletSummary.locked_fmv
            : (totals.totalCount > 0 ? totals.lockedFmv : null)
          const lockedCount: number | null = walletSummary
            ? walletSummary.locked_count
            : (totals.totalCount > 0 ? totals.lockedCount : null)
          const bestOfferTotal: number | null = totals.totalBestOffer > 0 ? totals.totalBestOffer : null
          const spreadGap: number | null = (walletFmv !== null && bestOfferTotal !== null)
            ? walletFmv - bestOfferTotal
            : null
          const momentCount: number | null = (paginatedTotal || totals.totalCount) || null
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
              const loanRows = rows.filter(function(r) { return r.acquisitionMethod === "loan_default" })
              if (loanRows.length === 0) return null
              const total = loanRows.reduce(function(sum, r) {
                const principal = (typeof r.loanPrincipal === "number" && r.loanPrincipal > 0)
                  ? r.loanPrincipal
                  : (typeof r.costBasis === "number" && r.costBasis > 0 ? r.costBasis : 0)
                return sum + principal
              }, 0)
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
                    {loanRows.length.toLocaleString()} acquired via loan default ({"$" + total.toFixed(2)} principal)
                  </span>
                </div>
              )
            })()}
          </div>
          )
        })()}

        {/* Cost basis / P&L summary */}
        {hasSearched && (walletSummary?.cost_basis ? walletSummary.cost_basis > 0 : (costBasis.size > 0 || rows.some(function(r) { return r.costBasis != null }))) && (function() {
          let totalCost: number
          let totalFmv: number
          let totalPl: number
          let count = 0
          if (walletSummary && walletSummary.cost_basis > 0) {
            totalCost = walletSummary.cost_basis
            totalFmv = walletSummary.current_fmv
            totalPl = walletSummary.pnl
            for (const row of rows) {
              const cb = costBasis.get(row.flowId ?? "")
              const rowBasis = cb ? cb.buyPrice : (row.costBasis ?? 0)
              if (rowBasis > 0) count++
            }
          } else {
            totalCost = 0
            totalFmv = 0
            for (const row of rows) {
              const cb = costBasis.get(row.flowId ?? "")
              const rowBasis = cb ? cb.buyPrice : (row.costBasis ?? 0)
              if (rowBasis > 0 && row.fmv && row.fmv > 0) {
                totalCost += rowBasis
                totalFmv += row.fmv
                count++
              }
            }
            totalPl = totalFmv - totalCost
          }
          if (totalCost === 0) return null
          const plPct = totalCost > 0 ? (totalPl / totalCost) * 100 : 0
          const plColor = totalPl >= 0 ? "text-emerald-400" : "text-red-400"
          return (
            <div className="flex flex-wrap gap-6 items-center mb-4 p-3 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-sm font-mono">
              <div><span className="text-[color:var(--rpc-text-muted)]">Cost Basis:</span> <span className="text-[color:var(--rpc-text-primary)]">${totalCost.toFixed(2)}</span></div>
              <div><span className="text-[color:var(--rpc-text-muted)]">Current FMV:</span> <span className="text-[color:var(--rpc-text-primary)]">${totalFmv.toFixed(2)}</span></div>
              <div><span className="text-[color:var(--rpc-text-muted)]">P&amp;L:</span> <span className={plColor}>{totalPl >= 0 ? "+" : ""}{totalPl.toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(0)}%)</span></div>
              {walletSummary && walletSummary.cost_basis > 0
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
