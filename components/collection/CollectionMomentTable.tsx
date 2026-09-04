"use client"

// components/collection/CollectionMomentTable.tsx
// Step 3c of the wallet-collection monolith extraction (follows the view
// reducer, CollectionFilterBar and CollectionSortBar): the entire moment
// display region — mobile expandable cards AND the desktop table, including
// the per-row expanded panel (edition stats, cost basis, badges, recent sales,
// FMV-alert form) and the debug columns. JSX moved VERBATIM from
// app/(collections)/[collection]/collection/page.tsx; the page keeps all
// data-fetch/filter/sort state and passes it down. The FMV-alert form state
// (five useState pairs, used nowhere else) moved INTO this component.
import { Fragment, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { slugifyName } from "@/lib/entity-labels"
import { momentSubjectHref } from "@/lib/entity-href"
import { normalizeSetName, buildEditionScopeKey } from "@/lib/wallet-normalize"
import ExplainButton from "@/components/ExplainButton"
import { BADGE_TYPE_TO_TITLE } from "@/lib/topshot-badges"
import BadgeIcon from "@/components/BadgeIcon"
import SerialFmvBadge from "@/components/SerialFmvBadge"
import PriceBand30dBadge from "@/components/PriceBand30dBadge"
import { formatCurrency } from "@/lib/format"
import ThumbnailPreview from "@/components/collection/ThumbnailPreview"
import SerialBadge from "@/components/collection/SerialBadge"
import EditionRecentSales from "@/components/collection/EditionRecentSales"
import {
  type MomentRow,
  type WalletSearchResponse,
  type CollectionSeriesEntry,
} from "@/lib/collection/types"
import type { CollectionViewState } from "@/lib/collection/view-reducer"
import {
  ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR,
  BADGE_PILL_TITLES,
  seriesDisplayLabel,
  seriesIntToSeason,
  formatAcquiredAt,
  getParallel,
  getSerial,
  getMint,
  getTraits,
  getLocked,
  getThumbnailUrl,
  getBestAsk,
  getPrimarySerialBadge,
  debugReasonLabel,
  fmvDisplay,
} from "@/lib/collection/helpers"
import {
  momentTierColor,
  momentTierBgClass,
  momentHoloClass,
  computeMomentPnl,
  pnlColorClass,
  resolveMomentPnlBasis,
  resolveMomentBestOffer,
  computeAskFmvDelta,
  shouldShowAskBadge,
} from "@/lib/collection-moment-cells"
import { fmvBasis } from "@/lib/fmv-basis"

// The one sanctioned per-value FMV honesty marker: plain-words "from asks" for
// an ASK_ONLY FMV (0.9x a single seller's ask, never traded). Never the
// confidence enum. `fmvDisplay(row).askDerived` gates it.
const ASK_BASIS = fmvBasis("ASK_ONLY")!
function AskDerivedMark({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <div title={ASK_BASIS.title} className="text-[10px] text-[color:var(--rpc-text-muted)] font-mono">
      {ASK_BASIS.label}
    </div>
  )
}

export default function CollectionMomentTable(props: {
  isMobile: boolean
  filteredRows: MomentRow[]
  rowsCount: number
  summary: WalletSearchResponse["summary"]
  view: CollectionViewState
  toggleExpanded: (momentId: string) => void
  batchEditionStats: Map<string, { owned: number; locked: number }>
  costBasis: Map<string, { buyPrice: number; acquiredDate: string; fmvAtAcquisition: number | null; acquisitionMethod: string | null; costBasisLabel: string | null }>
  collectionSeriesMap: Map<number, CollectionSeriesEntry>
  collectionSlug: string
  badgeCollectionId: string
  connectedWallet: string | null
  ownerKey: string
  input: string
  hasSearched: boolean
  loading: boolean
  showDebug: boolean
  // Returns null when the sealed-pack read FAILED, a number when it answered.
  // ⚠ Not `number` with 0 for both — an em-dash for a failed read is a measured
  // zero the reader cannot tell from the real one. See CollectionTabClient.
  getPackCount: (setName: string) => number | null
  // Collection brand accent (collectionObj?.accent ?? var(--rpc-red)) — used by
  // the mobile thumbnail fallback + the primary-badge stat chip.
  accent: string
}) {
  const {
    isMobile, filteredRows, rowsCount, summary, view, toggleExpanded,
    batchEditionStats, costBasis, collectionSeriesMap, collectionSlug,
    badgeCollectionId, connectedWallet, ownerKey, input, hasSearched,
    loading, showDebug, getPackCount, accent,
  } = props
  const router = useRouter()
  // All Day lock state is frozen/undated (see PortfolioSummary + WMC-LOCK-FRESHNESS):
  // /api/allday-lock-refresh is unscheduled with no on-demand path, so every
  // is_locked flag is a stale past-run value. Render lock figures as "—" (not
  // tracked) rather than as current fact. Re-enable when a scheduled refresh lands.
  const lockUntracked = collectionSlug === "nfl-all-day"

  // Task 2: FMV Alert UI state
  const [alertOpenMomentId, setAlertOpenMomentId] = useState<string | null>(null)
  const [alertTargetPrice, setAlertTargetPrice] = useState("")
  const [alertNotifType, setAlertNotifType] = useState<"email" | "telegram">("email")
  const [alertStatus, setAlertStatus] = useState<"idle" | "saving" | "success" | "error">("idle")
  const [alertError, setAlertError] = useState("")

  const rows = { length: rowsCount }

  return (
    <>
        {/* Main table / mobile cards */}
        {isMobile ? (
          <div className="flex flex-col gap-2">
            {filteredRows.length === 0 ? (
              // The desktop table carries these two messages; the mobile branch
              // was a bare .map(), so an empty result rendered a BLANK area with
              // no explanation — on the primary phone surface. The two strings
              // are deliberately different claims: "you own nothing here" vs
              // "your filters are too tight". Collapsing them would tell a
              // collector holding 500 moments that they hold none.
              <div className="rpc-table-empty">
                {rows.length === 0
                  ? "No moments found for this wallet on this collection."
                  : "No moments match your current filters. Try adjusting the filters above."}
              </div>
            ) : filteredRows.map(function(row) {
              const expanded = !!view.expandedRows[row.momentId]
              const fmv = fmvDisplay(row)
              const mIsThreeStar = !!row.badgeInfo?.is_three_star_rookie
              const supaBadgesMraw = (row.badgeInfo?.badge_titles ?? []).filter(function(t) { return BADGE_PILL_TITLES.has(t) })
              const supaBadges = mIsThreeStar ? supaBadgesMraw.filter(function(t) { return !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) }) : supaBadgesMraw
              const scopeKey = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
              const editionCounts = { owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0, locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0 }
              const cbMap = costBasis.get(row.flowId ?? "")
              const cb = cbMap ?? (row.costBasis != null || row.costBasisLabel ? { buyPrice: row.costBasis ?? 0, acquiredDate: row.acquiredAt ?? "", fmvAtAcquisition: null, acquisitionMethod: row.acquisitionMethod ?? null, costBasisLabel: row.costBasisLabel ?? null } : undefined)
              return (
                <div key={row.momentId} className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-3 flex flex-col gap-1.5 cursor-pointer" onClick={function() { toggleExpanded(row.momentId) }} role="button" tabIndex={0} aria-expanded={expanded} onKeyDown={function(e) { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleExpanded(row.momentId) } }}>
                  {/* Row 1: Thumbnail + Player + Tier + Chevron */}
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 min-w-0 mr-2">
                      {(function() {
                        const mThumb = getThumbnailUrl(row, collectionSlug)
                        if (!mThumb) return null
                        return (
                          <img
                            src={mThumb}
                            alt={row.playerName ?? ""}
                            width={36}
                            height={48}
                            loading="lazy"
                            className="rounded object-cover shrink-0"
                            style={{ width: 36, height: 48, background: "var(--rpc-surface)" }}
                            onClick={function(e) { e.stopPropagation(); router.push("/moment/" + row.momentId) }}
                            onError={function(e) { (e.target as HTMLImageElement).style.display = "none" }}
                          />
                        )
                      })()}
                      {row.playerName ? (
                        <Link
                          href={momentSubjectHref(collectionSlug, row.playerName, row.team) ?? "#"}
                          prefetch={false}
                          onClick={function(e) { e.stopPropagation() }}
                          className="font-semibold text-[color:var(--rpc-text-primary)] text-sm truncate"
                          style={{ textDecoration: "none" }}
                        >
                          {row.playerName}
                        </Link>
                      ) : (
                        <span className="font-semibold text-[color:var(--rpc-text-primary)] text-sm truncate">{row.playerName}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5">
                      {row.tier && (
                        <span className={"rounded px-1.5 py-0.5 text-[10px] font-bold shrink-0 " + momentTierBgClass(row.tier)} style={{ color: momentTierColor(row.tier) }}>
                          {row.tier}
                        </span>
                      )}
                      <span className="text-[color:var(--rpc-text-muted)] text-xs shrink-0">{expanded ? "▾" : "›"}</span>
                    </div>
                  </div>
                  {/* Row 2: Set + Series */}
                  <div className="text-xs text-[color:var(--rpc-text-secondary)]">
                    {row.setName ? (
                      <Link
                        href={`/${collectionSlug}/set/${slugifyName(row.setName)}`}
                        prefetch={false}
                        onClick={function(e) { e.stopPropagation() }}
                        style={{ color: "inherit", textDecoration: "none" }}
                      >
                        {normalizeSetName(row.setName)}
                      </Link>
                    ) : (
                      normalizeSetName(row.setName)
                    )}
                    &nbsp;&middot;&nbsp;{seriesIntToSeason(row.series, collectionSeriesMap) || "—"}
                  </div>
                  {/* Row 3: Serial, Badges */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-xs font-mono text-[color:var(--rpc-text-primary)]">#{getSerial(row) ?? "-"}<span className="text-[color:var(--rpc-text-muted)]">/{getMint(row) ?? "-"}</span></span>
                      <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} collection={collectionSlug} />
                      {editionCounts.owned > 1 && (
                        <span
                          className="text-[10px] font-mono text-[color:var(--rpc-text-secondary)]"
                          title={lockUntracked ? `You hold ${editionCounts.owned} of this edition` : `You hold ${editionCounts.owned} of this edition · ${editionCounts.locked} locked`}
                        >
                          ×{editionCounts.owned}{!lockUntracked && editionCounts.locked > 0 ? ` (${editionCounts.locked}🔒)` : ""}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-center">
                      {supaBadges.map(function(title) { return <BadgeIcon key={"m-" + title} title={title} collectionId={badgeCollectionId} /> })}
                    </div>
                  </div>
                  {/* Row 4: FMV, Low Ask, Cost/P&L */}
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex flex-col items-start gap-0.5">
                      <span
                        className={"text-sm font-mono " + (fmv.muted ? "text-[color:var(--rpc-text-muted)]" : "text-green-400")}
                        title={fmv.stale ? "No sales in 30+ days — FMV may be inaccurate" : undefined}
                        style={fmv.stale ? { textDecoration: "underline dotted", textDecorationColor: "rgba(156,163,175,0.5)", textUnderlineOffset: "3px" } : undefined}
                      >
                        {fmv.text}
                      </span>
                      <AskDerivedMark show={fmv.askDerived} />
                      {row.serialFmv ? <SerialFmvBadge data={row.serialFmv} /> : null}
                      {row.priceBand30d ? <PriceBand30dBadge data={row.priceBand30d} /> : null}
                    </span>
                    {row.lowAsk != null && (
                      <span className="text-xs text-[color:var(--rpc-text-secondary)]">Ask ${row.lowAsk.toFixed(2)}</span>
                    )}
                    {cb ? (function() {
                      const label = cb.costBasisLabel
                      if (label === "Pack") return <span className="inline-block rounded border border-[color:var(--rpc-border-hover)] bg-[var(--rpc-surface-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--rpc-text-muted)]">PACK</span>
                      if (label === "Gift") return <span className="inline-block rounded border border-blue-900 bg-blue-900 px-1.5 py-0.5 font-mono text-[10px] text-blue-400">GIFT</span>
                      if (label === "Reward") return <span className="inline-block rounded border border-purple-900 bg-purple-900 px-1.5 py-0.5 font-mono text-[10px] text-purple-400">REWARD</span>
                      if (label === "Airdrop") return <span className="inline-block rounded border border-green-900 bg-green-900 px-1.5 py-0.5 font-mono text-[10px] text-green-400">AIRDROP</span>
                      // ⚠ This used to be `label === "Loan" ? cb.buyPrice : cb.buyPrice`
                      // — a ternary whose branches are identical, i.e. `cb.buyPrice`
                      // unconditionally. That silently DIVERGED from the desktop P&L
                      // column, which derives its basis through the shared, named
                      // resolveMomentPnlBasis(): only a "Bought"/"Loan" cost-basis
                      // amount is trusted as a purchase price, and anything else falls
                      // back to lastPurchasePrice. So a row carrying a cost-basis
                      // amount with NO label — the shape the `cb` fallback just above
                      // constructs from row.costBasis when row.costBasisLabel is null —
                      // produced one P&L on a phone and a different one on a desktop,
                      // for the same moment. The helper was written for the desktop
                      // column and never applied here.
                      // Desktop splits these across TWO columns: a Cost cell that
                      // shows any positive buyPrice, and a P&L cell whose basis comes
                      // from resolveMomentPnlBasis (only "Bought"/"Loan" are trusted as
                      // a purchase price, else lastPurchasePrice). The mobile card
                      // renders both in one block, so it needs both numbers — deriving
                      // one from the other is what made the two layouts disagree.
                      const pnlBasis = resolveMomentPnlBasis(label, cb.buyPrice, row.lastPurchasePrice)
                      if (pnlBasis > 0 && row.fmv) {
                        const basis = pnlBasis
                        const { pl, plPct, positive } = computeMomentPnl(row.fmv, basis)
                        const color = pnlColorClass(positive)
                        return (
                          <div className="text-right">
                            <div className="text-xs font-mono text-[color:var(--rpc-text-secondary)]" title={label === "Loan" ? "Acquired via loan default. The displayed price is the principal that was lent against this moment in USDCF (1:1 USD)." : undefined}>{label === "Loan" ? <span className="text-red-400">Loan Default </span> : null}${basis.toFixed(2)}</div>
                            <div className={"text-[10px] font-mono " + color}>{pl >= 0 ? "+" : ""}{pl.toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(0)}%)</div>
                          </div>
                        )
                      }
                      // No trusted P&L basis, but there IS a cost figure. Desktop's Cost
                      // cell still shows it, so the card does too — omitting it entirely
                      // would hide a real number rather than avoid a fabricated one.
                      if (cb.buyPrice > 0) {
                        return (
                          <div className="text-right">
                            <div className="text-xs font-mono text-[color:var(--rpc-text-secondary)]">${cb.buyPrice.toFixed(2)}</div>
                          </div>
                        )
                      }
                      return null
                    })() : null}
                  </div>
                  {/* Expanded content */}
                  {expanded && (
                    <div className="rpc-expand-panel mt-2">
                      <div className="rpc-expand-section">
                        <div className="rpc-expand-section-eyebrow">Details</div>
                        <div className="rpc-expand-grid">
                          <div className="rpc-expand-field">
                            <div className="rpc-expand-field-label">Low Ask</div>
                            <div className="rpc-expand-field-value rpc-table-cell--mono">{formatCurrency(row.lowAsk ?? getBestAsk(row))}</div>
                          </div>
                          <div className="rpc-expand-field">
                            <div className="rpc-expand-field-label">Best Offer</div>
                            <div className="rpc-expand-field-value rpc-table-cell--mono">{formatCurrency(row.bestOffer ?? row.editionBestOffer)}</div>
                          </div>
                          <div className="rpc-expand-field">
                            <div className="rpc-expand-field-label">FMV</div>
                            <div className="rpc-expand-field-value rpc-table-cell--mono">
                              {fmv.text} <ExplainButton context={`${row.playerName ?? ""} — ${row.setName ?? ""} (${row.editionKey ?? ""}) FMV ${fmv.text}`} question="How is this FMV calculated?" />
                              <AskDerivedMark show={fmv.askDerived} />
                            </div>
                          </div>
                          {/* Confidence field removed 2026-07-11 — build-time signal only. */}
                          <div className="rpc-expand-field">
                            <div className="rpc-expand-field-label">Held / Locked</div>
                            <div className="rpc-expand-field-value rpc-table-cell--mono">{editionCounts.owned} / {lockUntracked ? "—" : editionCounts.locked}</div>
                          </div>
                        </div>
                      </div>
                      <div className="rpc-expand-section">
                        <div className="rpc-expand-section-eyebrow">Links</div>
                        <div className="flex flex-wrap gap-2">
                          <Link href={"/moment/" + row.momentId} prefetch={false} onClick={function(e) { e.stopPropagation() }} className="rpc-expand-link">View on RPC</Link>
                          <a href={"https://nbatopshot.com/moment/" + row.momentId} target="_blank" rel="noopener noreferrer" className="rpc-expand-link">View on Top Shot</a>
                        </div>
                      </div>
                      <div className="rpc-expand-section">
                        <div className="rpc-expand-section-eyebrow">Recent sales for this edition</div>
                        <EditionRecentSales editionKey={row.editionKey ?? null} mintCount={getMint(row)} />
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {summary && summary.remainingMoments > 0 && isMobile && (
              <div className="mt-3 rounded-lg border border-[color:var(--rpc-border-hover)] bg-[var(--rpc-surface)] px-3 py-2 text-center text-xs text-[color:var(--rpc-text-muted)]">
                Showing {rows.length} of {summary.totalMoments} moments — open on desktop for full collection
              </div>
            )}
          </div>
        ) : (
        <div className="rpc-table-wrapper">
          <table className="rpc-table">
            <thead>
              <tr>
                <th>Player</th>
                <th className="hidden sm:table-cell">Set</th>
                <th className="hidden sm:table-cell">Series</th>
                <th className="hidden md:table-cell">Parallel</th>
                <th className="hidden md:table-cell">Rarity</th>
                <th className="hidden sm:table-cell">Serial / Mint</th>
                <th className="hidden lg:table-cell">Held / Locked</th>
                <th className="hidden xl:table-cell">Packs</th>
                <th className="whitespace-nowrap">FMV</th>
                <th className="hidden xl:table-cell">Paid</th>
                <th className="hidden xl:table-cell">P&amp;L</th>
                <th className="hidden lg:table-cell">Low Ask</th>
                <th className="hidden lg:table-cell">Best Offer</th>
                <th className="hidden xl:table-cell">Acquired</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && hasSearched && !loading ? (
                <tr>
                  <td colSpan={15} className="rpc-table-empty">
                    {rows.length === 0
                      ? "No moments found for this wallet on this collection."
                      : "No moments match your current filters. Try adjusting the filters above."}
                  </td>
                </tr>
              ) : filteredRows.map(function(row) {
                const scopeKey = buildEditionScopeKey({ editionKey: row.editionKey, setName: row.setName, playerName: row.playerName, parallel: row.parallel, subedition: row.subedition })
                const editionCounts = { owned: row.editionsOwned ?? batchEditionStats.get(scopeKey)?.owned ?? 0, locked: row.editionsLocked ?? batchEditionStats.get(scopeKey)?.locked ?? 0 }
                const expanded = !!view.expandedRows[row.momentId]
                const primaryBadge = getPrimarySerialBadge(row)
                const isThreeStar = !!row.badgeInfo?.is_three_star_rookie
                const supaBadgesRaw = (row.badgeInfo?.badge_titles ?? []).filter(function(t) { return BADGE_PILL_TITLES.has(t) })
                const supaBadges = isThreeStar ? supaBadgesRaw.filter(function(t) { return !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) }) : supaBadgesRaw
                const officialBadgesRaw = row.officialBadges ?? []
                const officialBadges = officialBadgesRaw
                  .map(function(b) { return BADGE_TYPE_TO_TITLE[b] ?? null })
                  .filter(function(t: string | null): t is string { return t !== null && BADGE_PILL_TITLES.has(t) })
                  .filter(function(t: string) { return !isThreeStar || !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) })
                const fmv = fmvDisplay(row)
                const isLocked = getLocked(row)

                return (
                  <Fragment key={row.momentId}>
                    <tr
                      onClick={function(e) { const t = e.target as HTMLElement; if (t.closest("a,button,input,svg,video")) return; router.push("/moment/" + row.momentId) }}
                      role="button"
                      tabIndex={0}
                      aria-label={"Open " + (row.playerName ?? "moment") + " moment"}
                      onKeyDown={function(e) { if (e.target !== e.currentTarget) return; if (e.key === "Enter" || e.key === " ") { e.preventDefault(); router.push("/moment/" + row.momentId) } }}
                      className={"group align-top cursor-pointer " + (expanded ? "rpc-table-row--expanded " : "")}
                    >
                      <td className="rpc-table-cell--player min-w-[160px]">
                        <div className="flex items-center gap-2">
                          {(() => {
                            const thumbUrl = getThumbnailUrl(row, collectionSlug)
                            const tierColorForPrev = momentTierColor(row.tier)
                            const holo = momentHoloClass(row.tier)
                            return (
                              <div className={"relative shrink-0" + (holo ? " " + holo : "")} style={{ width: 48, height: 64 }}>
                                {(function() {
                                  const initials = (row.playerName ?? "")
                                    .split(/\s+/)
                                    .filter(Boolean)
                                    .slice(0, 2)
                                    .map(function(s) { return s[0]?.toUpperCase() ?? "" })
                                    .join("")
                                  const fallback = (
                                    <div
                                      className="rounded flex items-center justify-center cursor-pointer"
                                      style={{ /* brand-exception: white on tier-accent fill */ width: 48, height: 64, background: accent, color: "#fff", fontFamily: "var(--font-display)", fontWeight: 900, fontSize: 16, letterSpacing: "0.04em" }}
                                      onClick={function(e) { e.stopPropagation(); router.push("/moment/" + row.momentId) }}
                                      title={row.playerName}
                                    >
                                      {initials || "—"}
                                    </div>
                                  )
                                  if (!thumbUrl) return fallback
                                  return (
                                    <ThumbnailPreview thumbUrl={thumbUrl} playerName={row.playerName} tierColor={tierColorForPrev}>
                                      <img
                                        src={thumbUrl}
                                        alt={row.playerName}
                                        width={48}
                                        height={64}
                                        loading="lazy"
                                        className="rounded object-cover cursor-pointer"
                                        style={{ width: 48, height: 64, background: "var(--rpc-surface)" }}
                                        onClick={function(e) { e.stopPropagation(); router.push("/moment/" + row.momentId) }}
                                        onError={function(e) {
                                          const img = e.target as HTMLImageElement
                                          img.style.display = "none"
                                          const parent = img.parentElement
                                          if (parent && !parent.querySelector("[data-rpc-fallback]")) {
                                            const div = document.createElement("div")
                                            div.setAttribute("data-rpc-fallback", "1")
                                            // brand-exception: white on tier-accent fill (img onError fallback)
                                            div.style.cssText = "width:48px;height:64px;border-radius:4px;display:flex;align-items:center;justify-content:center;color:#fff;font-family:var(--font-display);font-weight:900;font-size:16px;letter-spacing:0.04em;background:" + accent
                                            div.textContent = initials || "—"
                                            parent.appendChild(div)
                                          }
                                        }}
                                      />
                                    </ThumbnailPreview>
                                  )
                                })()}
                              </div>
                            )
                          })()}
                          <div>
                            <div className="font-semibold text-[color:var(--rpc-text-primary)] text-sm">
                              {row.playerName ? (
                                <Link
                                  href={momentSubjectHref(collectionSlug, row.playerName, row.team) ?? "#"}
                                  prefetch={false}
                                  style={{ color: "inherit", textDecoration: "none" }}
                                >
                                  {row.playerName}
                                </Link>
                              ) : (
                                <span>{row.playerName}</span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap gap-1 items-center">
                              {officialBadges.map(function(title) { return <BadgeIcon key={"official-" + title} title={title} collectionId={badgeCollectionId} /> })}
                              {supaBadges.map(function(title) { return <BadgeIcon key={"supa-" + title} title={title} collectionId={badgeCollectionId} /> })}
                              {row.badgeInfo?.is_three_star_rookie && row.badgeInfo?.has_rookie_mint && (
                                <BadgeIcon title="Three-Star Rookie" collectionId={badgeCollectionId} />
                              )}
                            </div>
                            {row.acquisitionMethod && (() => {
                                const acqConfig: Record<string, { label: string; icon: string; prefix?: string; color: string; title?: string }> = {
                                  pack_pull: { label: "PACK", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4", color: "20,184,166" },
                                  marketplace: { label: "MKT", icon: "", color: "161,161,170" },
                                  challenge_reward: { label: "REWARD", icon: "M12 15l-2 5h4l-2-5zm-4-3a4 4 0 0 1 8 0H8zm-2-2h12l1-2H5l1 2zm3-4h6V3H9v3z", color: "245,158,11" },
                                  gift: { label: "GIFT", icon: "", prefix: "🎁 ", color: "168,85,247" },
                                  loan_default: { label: "LOAN DEFAULT", icon: "M14 11l7-7M9 7l7 7M3 21l4-4M9 11l4 4M14 4l6 6M3 13l8 8", color: "239,68,68", title: "Acquired via loan default. The displayed price is the principal that was lent against this moment in USDCF (1:1 USD)." },
                                  airdrop: { label: "AIRDROP", icon: "", color: "52,211,153" },
                                  unknown: { label: "? UNVERIFIED", icon: "", color: "113,113,122" },
                                }
                                const cfg = acqConfig[row.acquisitionMethod!]
                                if (!cfg) return null
                                return (
                                  <div className="mt-1">
                                    <span title={cfg.title} className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] font-medium" style={{ background: "rgba(" + cfg.color + ",0.12)", color: "rgba(" + cfg.color + ",0.9)", border: "1px solid rgba(" + cfg.color + ",0.3)" }}>
                                      {cfg.icon && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d={cfg.icon}/></svg>}
                                      {cfg.prefix ?? ""}{cfg.label}
                                    </span>
                                  </div>
                                )
                              })()}
                          </div>
                        </div>
                      </td>
                      <td className="text-sm hidden sm:table-cell">
                        {row.setName ? (
                          <Link
                            href={`/${collectionSlug}/set/${slugifyName(row.setName)}`}
                            prefetch={false}
                            style={{ color: "inherit", textDecoration: "none" }}
                          >
                            {normalizeSetName(row.setName)}
                          </Link>
                        ) : (
                          normalizeSetName(row.setName)
                        )}
                      </td>
                      <td className="text-sm hidden sm:table-cell">{seriesDisplayLabel(row.series, collectionSeriesMap)}</td>
                      <td className="text-sm hidden md:table-cell">{getParallel(row)}</td>
                      <td className="text-sm hidden md:table-cell">{row.tier ?? "—"}</td>
                      <td className="rpc-table-cell--mono hidden sm:table-cell">
                        <div className={"inline-flex min-w-[80px] flex-col rounded-lg border px-2 py-1 " + (primaryBadge ? "" : "border-[color:var(--rpc-border)] bg-[var(--rpc-black)]")} style={primaryBadge ? { borderColor: accent, backgroundColor: accent + "1A" } : undefined}>
                          <SerialBadge serial={row.serial} mintSize={row.mintSize} jerseyNumber={row.jerseyNumber} collection={collectionSlug} />
                          <div className={"text-sm font-black flex items-center gap-1 " + (primaryBadge ? "" : "text-[color:var(--rpc-text-primary)]")} style={primaryBadge ? { color: accent } : undefined}>
                            <span>{"#" + (getSerial(row) ?? "-")}</span>
                          </div>
                          <div className="text-xs text-[color:var(--rpc-text-secondary)]">{"/ " + (getMint(row) ?? "-")}</div>
                          {primaryBadge ? <div className="mt-1 rounded bg-[var(--rpc-surface-raised)] px-1 py-0.5 text-[9px] font-bold text-[color:var(--rpc-text-primary)]">{primaryBadge}</div> : null}
                        </div>
                      </td>
                      <td className="text-sm hidden lg:table-cell">
                        <div>{editionCounts.owned} / {lockUntracked ? "—" : editionCounts.locked}</div>
                        {row.badgeInfo && row.badgeInfo.circulation_count != null && row.badgeInfo.circulation_count > 0 && !(row.badgeInfo.circulation_count === 1 || row.tier?.toUpperCase() === "ULTIMATE") && (
                          <div className="mt-1 text-[10px] text-[color:var(--rpc-text-muted)] font-mono leading-tight" title={"Minted: " + row.badgeInfo.circulation_count + " · Owned: " + row.badgeInfo.owned + " · For Sale: " + (row.badgeInfo.for_sale_by_collectors ?? "?") + " · In Packs: " + row.badgeInfo.hidden_in_packs + " · Burned: " + row.badgeInfo.burned}>
                            <span>{row.badgeInfo.circulation_count.toLocaleString()} minted</span>
                            {row.badgeInfo.burned > 0 && <span className="text-red-400"> · {row.badgeInfo.burned} burned</span>}
                            {row.badgeInfo.hidden_in_packs > 0 && <span> · {row.badgeInfo.hidden_in_packs} in packs</span>}
                          </div>
                        )}
                        {(row.badgeInfo?.circulation_count === 1 || row.tier?.toUpperCase() === "ULTIMATE") && (
                          <div className="mt-1 text-[10px] text-purple-400 font-mono">1/1</div>
                        )}
                      </td>
                      <td className="text-sm hidden xl:table-cell">
                        {(function() {
                          const count = getPackCount(row.setName)
                          if (count === null) {
                            return (
                              <span
                                className="text-[color:var(--rpc-text-muted)]"
                                title="Sealed pack data is unavailable right now — this is not a count of zero."
                              >
                                ?
                              </span>
                            )
                          }
                          if (!count) return <span className="text-[color:var(--rpc-text-muted)]">—</span>
                          return (
                            <a href={"/" + collectionSlug + "/packs?wallet=" + encodeURIComponent(input.trim())} className="hover:opacity-80" style={{ color: accent }}>
                              {count + (count === 1 ? " pack" : " packs")}
                            </a>
                          )
                        })()}
                      </td>
                      <td className="rpc-table-cell--mono min-w-[90px] whitespace-nowrap">
                        <div
                          className={"font-semibold text-sm " + (fmv.muted ? "text-[color:var(--rpc-text-muted)]" : "text-[color:var(--rpc-text-primary)]")}
                          title={fmv.stale ? "No sales in 30+ days — FMV may be inaccurate" : undefined}
                          style={fmv.stale ? { textDecoration: "underline dotted", textDecorationColor: "rgba(156,163,175,0.5)", textUnderlineOffset: "3px" } : undefined}
                        >
                          {fmv.text}
                        </div>
                        <AskDerivedMark show={fmv.askDerived} />
                        {row.serialFmv ? <div className="mt-0.5"><SerialFmvBadge data={row.serialFmv} /></div> : null}
                        {row.priceBand30d ? <div className="mt-0.5"><PriceBand30dBadge data={row.priceBand30d} /></div> : null}
                        {(function() {
                          const d = computeAskFmvDelta(row.marketConfidence, row.fmv, row.lowAsk)
                          if (!d) return null
                          return (
                            <div className={"text-[10px] font-mono " + d.colorClass}>
                              {d.label}
                            </div>
                          )
                        })()}
                        {(function() {
                          const ask = getBestAsk(row)
                          if (!shouldShowAskBadge(ask, row.fmv)) return null
                          return <div className="text-[10px] text-[color:var(--rpc-text-muted)] font-mono">Ask {"$" + (ask as number).toFixed(2)}</div>
                        })()}
                        {row.lastPurchasePrice != null && row.lastPurchasePrice > 0 && (
                          <div className="text-[9px] text-[color:var(--rpc-text-muted)] font-mono">Paid {formatCurrency(row.lastPurchasePrice)}</div>
                        )}
                      </td>
                      <td className="text-sm hidden xl:table-cell" title={row.acquisitionMethod === "loan_default" ? "Acquired via loan default. The displayed price is the principal that was lent against this moment in USDCF (1:1 USD)." : undefined}>
                        {(function() {
                          const cbMap = costBasis.get(row.flowId ?? "")
                          const cb = cbMap ?? (row.costBasis != null || row.costBasisLabel ? { buyPrice: row.costBasis ?? 0, acquiredDate: row.acquiredAt ?? "", fmvAtAcquisition: null, acquisitionMethod: row.acquisitionMethod ?? null, costBasisLabel: row.costBasisLabel ?? null } : undefined)
                          const src = (row.acquisitionSource ?? "").toLowerCase()
                          const TS_SOURCES = new Set(["browser_backfill", "smm_final", "wallet_search", "progressive_classify", "sales_backfill"])
                          let sourcePill: React.ReactNode = null
                          if (src && TS_SOURCES.has(src)) {
                            sourcePill = <span className="ml-1 inline-flex items-center rounded px-1 py-0 font-mono text-[9px] font-semibold text-[color:var(--rpc-red)]" style={{ border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.10)" }}>TS</span>
                          }
                          if (cb) {
                            const label = cb.costBasisLabel
                            if (label === "Bought" && cb.buyPrice > 0) return <span className="font-mono text-[color:var(--rpc-text-primary)]">${cb.buyPrice.toFixed(2)}{sourcePill}</span>
                            if (label === "Pack") return <span className="inline-block rounded border border-[color:var(--rpc-border-hover)] bg-[var(--rpc-surface-raised)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--rpc-text-muted)]">PACK</span>
                            if (label === "Loan" && cb.buyPrice > 0) return <span className="font-mono"><span className="text-red-400">Loan Default</span> <span className="text-[color:var(--rpc-text-primary)]">${cb.buyPrice.toFixed(2)}</span>{sourcePill}</span>
                            if (label === "Gift") return <span className="inline-block rounded border border-blue-900 bg-blue-900 px-1.5 py-0.5 font-mono text-[10px] text-blue-400">GIFT</span>
                            if (label === "Reward") return <span className="inline-block rounded border border-purple-900 bg-purple-900 px-1.5 py-0.5 font-mono text-[10px] text-purple-400">REWARD</span>
                            if (label === "Airdrop") return <span className="inline-block rounded border border-green-900 bg-green-900 px-1.5 py-0.5 font-mono text-[10px] text-green-400">AIRDROP</span>
                            if (cb.buyPrice > 0) return <span className="font-mono text-[color:var(--rpc-text-primary)]">${cb.buyPrice.toFixed(2)}{sourcePill}</span>
                          }
                          if (row.lastPurchasePrice != null && row.lastPurchasePrice > 0) return <span className="font-mono text-[color:var(--rpc-text-secondary)]">{formatCurrency(row.lastPurchasePrice)}{sourcePill}</span>
                          return <span className="text-[color:var(--rpc-text-muted)]">—</span>
                        })()}
                      </td>
                      <td className="text-sm hidden xl:table-cell">
                        {(function() {
                          const currentFmv = row.fmv
                          if (!currentFmv) return <span className="text-[color:var(--rpc-text-muted)]">—</span>
                          const cbMap = costBasis.get(row.flowId ?? "")
                          const cbObj = cbMap ?? (row.costBasis != null || row.costBasisLabel ? { buyPrice: row.costBasis ?? 0, costBasisLabel: row.costBasisLabel ?? null } : undefined)
                          const basis = resolveMomentPnlBasis(cbObj?.costBasisLabel, cbObj?.buyPrice, row.lastPurchasePrice)
                          if (!basis || basis <= 0) return <span className="text-[color:var(--rpc-text-muted)]">—</span>
                          const { pl, plPct, positive } = computeMomentPnl(currentFmv, basis)
                          const color = pnlColorClass(positive)
                          return (
                            <div className={"font-mono " + color}>
                              <div>{pl >= 0 ? "+" : ""}{pl.toFixed(2)}</div>
                              <div className="text-[10px]">{pl >= 0 ? "+" : ""}{plPct.toFixed(0)}%</div>
                            </div>
                          )
                        })()}
                      </td>
                      <td className="rpc-table-cell--mono text-sm hidden lg:table-cell">
                        {row.lowAsk != null ? (
                          <span style={{ color: row.fmv && row.lowAsk < row.fmv ? "#22c55e" : "#9ca3af" }}>
                            ${row.lowAsk.toFixed(2)}
                          </span>
                        ) : row.editionLowAsk != null ? (
                          <span style={{ color: row.fmv && row.editionLowAsk < row.fmv ? "#22c55e" : "#9ca3af" }}>
                            ${row.editionLowAsk.toFixed(2)}
                            <span className="ml-1 text-[10px] text-[color:var(--rpc-text-muted)]">floor</span>
                          </span>
                        ) : (
                          <span className="text-[color:var(--rpc-text-muted)]">—</span>
                        )}
                      </td>
                      <td className="rpc-table-cell--mono text-sm hidden lg:table-cell">
                        {(function() {
                          // Show the higher of edition vs serial offer
                          const best = resolveMomentBestOffer({ bestOffer: row.bestOffer, editionOffer: row.editionOffer, editionBestOffer: row.editionBestOffer, bestOfferType: row.bestOfferType })
                          if (!best) return <span className="text-[color:var(--rpc-text-muted)]">—</span>
                          return (
                            <div>
                              <div className="text-[color:var(--rpc-text-secondary)] font-semibold">{formatCurrency(best.val)}</div>
                              <div className="text-[10px] font-mono text-[color:var(--rpc-text-muted)]">{best.label} offer</div>
                              {best.val > (getBestAsk(row) ?? Infinity) && (
                                <span className="inline-block mt-0.5 rounded bg-emerald-950 px-1.5 py-0.5 text-[10px] font-bold text-emerald-400 border border-emerald-800">Flip</span>
                              )}
                            </div>
                          )
                        })()}
                      </td>
                      <td className="rpc-table-cell--muted text-xs hidden xl:table-cell">
                        <div>{formatAcquiredAt(row.acquiredAt)}</div>
                        {(() => {
                          const acqPillMap: Record<string, { label: string; cls: string; title?: string }> = {
                            pack_pull:        { label: "PACK",         cls: "bg-green-950 text-green-300 border border-green-800" },
                            marketplace:      { label: "MKT",          cls: "bg-[var(--rpc-surface-raised)] text-[color:var(--rpc-text-secondary)] border border-[color:var(--rpc-border-hover)]" },
                            challenge_reward: { label: "REWARD",       cls: "bg-amber-950 text-amber-300 border border-amber-800" },
                            gift:             { label: "🎁 GIFT",      cls: "bg-purple-950 text-purple-300 border border-purple-700" },
                            loan_default:     { label: "LOAN DEFAULT", cls: "bg-red-950 text-red-300 border border-red-800", title: "Acquired via loan default. The displayed price is the principal that was lent against this moment in USDCF (1:1 USD)." },
                            airdrop:          { label: "AIRDROP",      cls: "bg-emerald-950 text-emerald-300 border border-emerald-800" },
                          }
                          const cfg = row.acquisitionMethod ? acqPillMap[row.acquisitionMethod] : null
                          if (!cfg) return null
                          return <span title={cfg.title} className={"mt-0.5 inline-block text-[9px] font-bold px-1 py-0.5 rounded " + cfg.cls}>{cfg.label}</span>
                        })()}
                      </td>
                      <td>
                        <div className="flex items-center gap-1.5 relative">
                          <button onClick={function() { toggleExpanded(row.momentId) }} className="rounded-lg border border-[color:var(--rpc-border-hover)] px-2 py-1 text-xs text-[color:var(--rpc-text-primary)] hover:bg-[var(--rpc-surface)]">
                            {expanded ? "Hide" : "Show"}
                          </button>
                          {/* Task 2: FMV Alert bell */}
                          <button
                            onClick={function(e) { e.stopPropagation(); if (alertOpenMomentId === row.momentId) { setAlertOpenMomentId(null) } else { setAlertOpenMomentId(row.momentId); setAlertTargetPrice(row.fmv ? (Math.round(row.fmv * 0.85 * 100) / 100).toString() : ""); setAlertNotifType("email"); setAlertStatus("idle"); setAlertError("") } }}
                            className="rounded-lg border border-[color:var(--rpc-border-hover)] px-2 py-1 text-xs hover:bg-[var(--rpc-surface)]"
                            title="Set FMV alert"
                            style={{ color: alertOpenMomentId === row.momentId ? accent : "#a1a1aa" }}
                          >
                            {"\uD83D\uDD14"}
                          </button>
                          {alertOpenMomentId === row.momentId && (
                            <div onClick={function(e) { e.stopPropagation() }} style={{ position: "absolute", top: "100%", right: 0, zIndex: 50, background: "var(--rpc-surface)", border: "1px solid #3f3f46", borderRadius: 8, padding: 12, width: 240, marginTop: 4 }}>
                              <div style={{ fontFamily: "var(--font-mono)", fontSize: 9, color: "var(--rpc-text-muted)", letterSpacing: "0.1em", marginBottom: 8 }}>SET FMV ALERT</div>
                              <div style={{ marginBottom: 8 }}>
                                <label style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#a1a1aa", display: "block", marginBottom: 4 }}>Target Price ($)</label>
                                <input type="number" min="0" step="0.01" value={alertTargetPrice} onChange={function(e) { setAlertTargetPrice(e.target.value) }} style={{ width: "100%", background: "var(--rpc-surface)", border: "1px solid #3f3f46", borderRadius: 6, padding: "6px 8px", color: "var(--rpc-text-primary)", fontFamily: "var(--font-mono)", fontSize: 12, outline: "none" }} />
                              </div>
                              <div style={{ marginBottom: 10 }}>
                                <label style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "#a1a1aa", display: "block", marginBottom: 4 }}>Notify via</label>
                                <div style={{ display: "flex", gap: 8 }}>
                                  {(["email", "telegram"] as const).map(function(t) {
                                    return <label key={t} style={{ display: "flex", alignItems: "center", gap: 4, fontFamily: "var(--font-mono)", fontSize: 11, color: alertNotifType === t ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)", cursor: "pointer" }}><input type="radio" name="alert-notif" checked={alertNotifType === t} onChange={function() { setAlertNotifType(t) }} style={{ accentColor: accent }} />{t === "email" ? "Email" : "Telegram"}</label>
                                  })}
                                </div>
                              </div>
                              {alertStatus === "success" && <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#4ade80", marginBottom: 6 }}>Alert set!</div>}
                              {alertStatus === "error" && (
                                <div style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "#f87171", marginBottom: 6 }}>
                                  {alertError === "signed_out" ? (
                                    <>
                                      <a href={"/login?redirect=" + encodeURIComponent(typeof window !== "undefined" ? window.location.pathname + window.location.search : "/nba-top-shot/collection")} style={{ color: accent, textDecoration: "underline" }}>Sign in</a> to save price alerts
                                    </>
                                  ) : alertError === "not_pro" ? (
                                    <>
                                      Free tier alert limit reached.{" "}
                                      <a href="mailto:support@rippackscity.com?subject=RPC%20Pro%20Early%20Access" style={{ color: accent, textDecoration: "underline" }}>Upgrade to Pro</a>
                                    </>
                                  ) : (
                                    "Failed to set alert"
                                  )}
                                </div>
                              )}
                              <button
                                disabled={alertStatus === "saving"}
                                onClick={function() {
                                  const ownerWallet = connectedWallet || ownerKey || input.trim()
                                  if (!ownerWallet) {
                                    setAlertStatus("error")
                                    setAlertError("signed_out")
                                    return
                                  }
                                  setAlertStatus("saving")
                                  fetch("/api/alerts", {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify({
                                      owner_key: ownerWallet,
                                      edition_key: row.editionKey || "",
                                      player_name: row.playerName,
                                      set_name: row.setName,
                                      alert_type: "below_price",
                                      threshold: parseFloat(alertTargetPrice) || 0,
                                      channel: alertNotifType,
                                    }),
                                  })
                                    .then(function(r) {
                                      if (r.status === 402) throw new Error("not_pro")
                                      if (!r.ok) throw new Error("save_failed")
                                      return r.json()
                                    })
                                    .then(function() { setAlertStatus("success"); setTimeout(function() { setAlertOpenMomentId(null) }, 1500) })
                                    .catch(function(err) {
                                      setAlertStatus("error")
                                      setAlertError(err.message)
                                    })
                                }}
                                style={{ /* brand-exception: white on tier-accent fill */ width: "100%", background: accent, color: "#fff", border: "none", borderRadius: 6, padding: "7px 0", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", cursor: "pointer", opacity: alertStatus === "saving" ? 0.5 : 1 }}
                              >
                                {alertStatus === "saving" ? "Setting..." : "Set Alert"}
                              </button>
                            </div>
                          )}
                        </div>
                      </td>
                    </tr>

                    {expanded ? (
                      <tr>
                        <td colSpan={16}>
                          <div className="rpc-expand-panel">
                            <div className="rpc-expand-section">
                              <div className="rpc-expand-section-eyebrow">Details</div>
                              <div className="rpc-expand-grid">
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Top Shot Ask</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{formatCurrency(row.topshotAsk ?? row.editionLowAsk)}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Best Ask</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{formatCurrency(getBestAsk(row) ?? row.editionLowAsk)}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Best Market</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{row.bestMarket ?? row.editionMarketSource ?? "—"}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Best Offer</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{formatCurrency(row.bestOffer ?? row.editionBestOffer)}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">FMV</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{fmv.text}<AskDerivedMark show={fmv.askDerived} /></div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">FMV Method</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{row.fmvMethod === "band" ? "Avg sales price" : row.fmvMethod === "low-ask-only" ? "Avg sales price" : row.fmvMethod === "best-offer-only" ? "Floor/Ask price" : row.fmvMethod === "none" ? "—" : (row.fmvMethod ?? "—")}</div>
                                </div>
                                {/* Confidence field removed 2026-07-11 — build-time signal only. */}
                                {/* Team is sourced from wallet_moments_cache.team_name (denormalized at backfill time), preferred over the live editions.team_name join in get_wallet_moments_with_fmv so it survives editions re-keying/churn. See migration audit_20260713_wmc_team_name_denorm. */}
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Team</div>
                                  <div className="rpc-expand-field-value">{row.team ?? "—"}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">League</div>
                                  <div className="rpc-expand-field-value">{row.league ?? "—"}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Parallel</div>
                                  <div className="rpc-expand-field-value">{getParallel(row)}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Series</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{row.series ?? "—"} ({seriesIntToSeason(row.series, collectionSeriesMap) || "—"})</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Acquired</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{formatAcquiredAt(row.acquiredAt)}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Locked</div>
                                  <div className="rpc-expand-field-value">{lockUntracked ? "—" : (isLocked ? "Yes" : "No")}</div>
                                </div>
                                <div className="rpc-expand-field">
                                  <div className="rpc-expand-field-label">Edition Key</div>
                                  <div className="rpc-expand-field-value rpc-table-cell--mono">{row.editionKey ?? "—"}</div>
                                </div>
                                {showDebug ? (
                                  <>
                                    <div className="rpc-expand-field">
                                      <div className="rpc-expand-field-label">Scope Key</div>
                                      <div className="rpc-expand-field-value rpc-expand-field-value--debug rpc-table-cell--mono">{scopeKey}</div>
                                    </div>
                                    <div className="rpc-expand-field">
                                      <div className="rpc-expand-field-label">Valuation</div>
                                      <div className="rpc-expand-field-value rpc-expand-field-value--debug rpc-table-cell--mono">{row.valuationScope ?? "—"}</div>
                                    </div>
                                    <div className="rpc-expand-field">
                                      <div className="rpc-expand-field-label">Market Source</div>
                                      <div className="rpc-expand-field-value rpc-expand-field-value--debug rpc-table-cell--mono">{row.marketSource ?? "—"}</div>
                                    </div>
                                    <div className="rpc-expand-field">
                                      <div className="rpc-expand-field-label">Reason</div>
                                      <div className="rpc-expand-field-value rpc-expand-field-value--debug rpc-table-cell--mono">{debugReasonLabel(row.marketDebugReason)}</div>
                                    </div>
                                    <div className="rpc-expand-field">
                                      <div className="rpc-expand-field-label">Edition Source</div>
                                      <div className="rpc-expand-field-value rpc-expand-field-value--debug rpc-table-cell--mono">{row.editionMarketSource ?? "—"}</div>
                                    </div>
                                  </>
                                ) : null}
                              </div>
                              {getTraits(row).length > 0 && (
                                <div className="mt-3 flex flex-wrap gap-1">
                                  {getTraits(row).map(function(trait) { return <span key={trait} className="rounded px-2 py-0.5 text-[10px]" style={{ backgroundColor: accent + "1A", color: accent }}>{trait}</span> })}
                                </div>
                              )}
                            </div>
                            <div className="rpc-expand-section">
                              <div className="rpc-expand-section-eyebrow">Links</div>
                              <div className="flex flex-wrap gap-2">
                                <Link href={"/moment/" + row.momentId} prefetch={false} className="rpc-expand-link">View on RPC</Link>
                                <a href={"https://nbatopshot.com/moment/" + row.momentId} target="_blank" rel="noopener noreferrer" className="rpc-expand-link">View on Top Shot</a>
                                {summary && (
                                  <a href={"/nba-top-shot/sets?wallet=" + encodeURIComponent(input.trim())} className="rpc-expand-link rpc-expand-link--muted">View Set Progress →</a>
                                )}
                              </div>
                            </div>
                            {row.badgeInfo?.badge_score ? (
                              <div className="rpc-expand-section">
                                <div className="rpc-expand-section-eyebrow">Badges</div>
                                <div className="space-y-2">
                                  <div className="flex items-center gap-2">
                                    <span className="text-xs" style={{ color: "var(--rpc-text-secondary)" }}>Score</span>
                                    <span className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-black text-[color:var(--rpc-text-primary)]" style={{ backgroundColor: accent }}>{row.badgeInfo.badge_score}</span>
                                  </div>
                                  <div className="flex flex-wrap gap-1">
                                    {(row.badgeInfo.badge_titles ?? [])
                                      .filter(function(t) { return BADGE_PILL_TITLES.has(t) })
                                      .filter(function(t) { return !row.badgeInfo?.is_three_star_rookie || !ROOKIE_BADGES_HIDDEN_WHEN_THREE_STAR.has(t) })
                                      .map(function(title) { return <BadgeIcon key={title} title={title} collectionId={badgeCollectionId} /> })}
                                  </div>
                                  <div className="text-[11px] font-mono space-y-0.5" style={{ color: "var(--rpc-text-muted)" }}>
                                    {/* burn_rate_pct/lock_rate_pct/circulation_count are nullable in badge_editions
                                        (e.g. ~16 rendered editions incl. Wembanyama S6), so guard before formatting —
                                        an unguarded .toFixed()/.toLocaleString() on null white-screens the whole table. */}
                                    <div>Burn rate: {row.badgeInfo.burn_rate_pct != null ? `${row.badgeInfo.burn_rate_pct.toFixed(1)}%` : "—"}</div>
                                    <div>Lock rate: {row.badgeInfo.lock_rate_pct != null ? `${row.badgeInfo.lock_rate_pct.toFixed(1)}%` : "—"}</div>
                                    {(row.badgeInfo.circulation_count === 1 || row.tier?.toUpperCase() === "ULTIMATE") ? (
                                      <div className="text-purple-400">1/1 Ultimate</div>
                                    ) : (
                                      <>
                                        {/* ⚠ `> 0`, NOT `!= null` (deep-audit R34). A 0 here is NOT a supply
                                            of zero — it is a row whose supply was never populated, and
                                            "Circ: 0" reads as a measured fact about the market. Measured
                                            2026-08-23: ALL 218 LaLiga Golazos badge rows carry
                                            circulation_count = 0 AND effective_supply = 0 (zero nulls), and
                                            all 218 are keyable by (player_name, series_number), so both
                                            lines rendered a fabricated supply on every Golazos row.
                                            ⚠ The correct guard already existed 350 lines up in THIS FILE —
                                            the "N minted" line at the row level tests
                                            `!= null && > 0`. One branch was guarded and its neighbour was
                                            not, which is why a per-PANEL fix is the rule and a per-page one
                                            is not. An edition that genuinely has zero circulation renders
                                            nothing here, which is the honest output: we have no supply. */}
                                        {row.badgeInfo.circulation_count != null && row.badgeInfo.circulation_count > 0 && <div>Circ: {row.badgeInfo.circulation_count.toLocaleString()}</div>}
                                        {row.badgeInfo.effective_supply != null && row.badgeInfo.effective_supply > 0 && <div>Effective supply: {row.badgeInfo.effective_supply.toLocaleString()}</div>}
                                        {row.badgeInfo.owned > 0 && <div>Owned: {row.badgeInfo.owned.toLocaleString()}</div>}
                                        {row.badgeInfo.for_sale_by_collectors != null && <div>For sale: {row.badgeInfo.for_sale_by_collectors.toLocaleString()}</div>}
                                        {row.badgeInfo.hidden_in_packs > 0 && <div>In packs: {row.badgeInfo.hidden_in_packs.toLocaleString()}</div>}
                                        {row.badgeInfo.burned > 0 && <div>Burned: {row.badgeInfo.burned.toLocaleString()}</div>}
                                      </>
                                    )}
                                    {row.badgeInfo.low_ask != null && <div>Edition ask: {formatCurrency(row.badgeInfo.low_ask)}</div>}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                            <div className="rpc-expand-section">
                              <div className="rpc-expand-section-eyebrow">Recent sales for this edition</div>
                              <EditionRecentSales editionKey={row.editionKey ?? null} mintCount={getMint(row)} />
                            </div>
                          </div>
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
        )}
    </>
  )
}
