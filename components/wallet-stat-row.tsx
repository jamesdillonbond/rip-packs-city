"use client"

import type { ReactNode } from "react"
import { formatCurrency, formatCount } from "@/lib/format"
import FmvDisclaimer from "@/components/legal/FmvDisclaimer"
import { closedMarket, formatClosedOn } from "@/lib/market-closed"
import { collectionHasLocking } from "@/lib/collections"
import { isUfcAptosBinder, type UfcAptosState } from "@/lib/ufc-aptos"

// The binder's value header (2026-11-24: one big number + plain stats, was four tiles), used by every collection's
// /[collection]/collection page (and the standalone Pinnacle page until
// it migrates onto the dynamic route).
//
// Value semantics:
//   null  → em-dash ("—") — not loaded yet OR concept doesn't apply
//   0     → "$0"          — real, computed zero (e.g. wallet has no locked moments)
//   N     → "$N" with thousands separators
//
// For Pinnacle (no locking concept) the Unlocked and Locked tiles are not
// rendered at all (collectionHasLocking, 2026-09-27) — an em-dash there still
// implied a lock state we did not know.
//
// loadProgress is optional. When provided AND loaded < total, the
// Wallet FMV caption swaps from "N moments" to a small progress bar
// showing how much of the wallet has been hydrated.

export type WalletStatRowProps = {
  /** UFC Strike: the Aptos half of the wallet (2026-11-26), added into ONE value with the Flow half. */
  ufcAptos?: UfcAptosState | null
  walletFmv: number | null
  unlockedFmv: number | null
  lockedFmv: number | null
  bestOfferTotal: number | null
  momentCount: number | null
  unlockedCount: number | null
  lockedCount: number | null
  /**
   * FMV whose lock state was NEVER CHECKED, and its count. Disclosed under the
   * Unlocked tile, never added into it: `wallet_moments_cache.is_locked`
   * defaults to `false`, so counting an unchecked moment as unlocked told the
   * collector they could sell something nobody had verified (register #112).
   * Null means the authoritative summary has not loaded — not that the figure
   * is zero.
   */
  lockUnknownFmv?: number | null
  lockUnknownCount?: number | null
  /** FMV of the moments the offer total covers, minus their offers (2026-11-14) — never the whole wallet's. */
  spreadGap: number | null
  /** How many moments the Best Offer Total covers (null when unknown). */
  bestOfferCount?: number | null
  /** What bestOfferCount counts: one bid per edition (wallet-wide read) or loaded moments. */
  bestOfferUnit?: "editions" | "moments"
  /** Locked / Unlocked are netted of the stale share, so they sum to the headline (2026-11-14). */
  staleNetted?: boolean
  /** Stale-priced share excluded from walletFmv; disclosed under the headline when > 0. */
  staleFmv?: number
  staleCount?: number
  /** The headline is a raw total because the stale split never arrived — say so. */
  staleUnknown?: boolean
  collectionSlug: string
  loading?: boolean
  loadProgress?: { loaded: number; total: number; pct: number } | null
  walletFmvAccessory?: ReactNode
  /** The WHOLE wallet's profit/loss on moments with a known cost; null/absent hides the stat. */
  pnl?: { amount: number; pct: number } | null
  /** Where the moments came from — drawn as one bar under the stats. */
  acquisition?: { packs: number; market: number; rewards: number; gifts?: number; total: number } | null
}

const PULSE_DOT_STYLE = {
  background: "var(--rpc-text-muted)",
  animation: "skeletonPulse 1.5s ease-in-out infinite",
} as const

function PulseDot() {
  return (
    <span
      className="inline-block h-1.5 w-1.5 rounded-full"
      style={PULSE_DOT_STYLE}
      aria-hidden="true"
    />
  )
}

// Whole dollars in the hero (2026-11-24, "digestible"): $41,039 reads at a glance, $41,039.07 does
// not, and the cents carry nothing on a five-figure wallet. Same three states as formatCurrency:
// null → "—", a real zero → "$0", otherwise signed with separators.
export function formatUsdWhole(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—"
  const r = Math.round(value)
  if (r === 0) return value === 0 ? "$0" : formatCurrency(value)
  return (r < 0 ? "-" : "") + "$" + Math.abs(r).toLocaleString("en-US")
}

function unitNoun(slug: string): string {
  return slug === "disney-pinnacle" ? "pins" : "moments"
}

export default function WalletStatRow(props: WalletStatRowProps) {
  const {
    walletFmv,
    unlockedFmv,
    bestOfferTotal,
    momentCount,
    lockUnknownFmv,
    lockUnknownCount,
    staleFmv,
    collectionSlug,
    loading,
    loadProgress,
    walletFmvAccessory,
    pnl,
    ufcAptos,
    acquisition,
  } = props

  const showProgress = loadProgress && loadProgress.loaded < loadProgress.total
  // Disney Pinnacle pins cannot be locked, so the Unlocked / Locked split is not
  // a thing to show — not even as an em-dash (lib/collections.ts).
  const hasLocking = collectionHasLocking(collectionSlug)
  const noun = unitNoun(collectionSlug)

  // Closed-market collections (e.g. UFC Strike, Flow market closed 2026-05-13)
  // have no current value, so we must NOT show a wallet total — the honest
  // signal is a count + a closure note. Fall through to the normal tiles once
  // the count has loaded so we never render a bare "market closed" with no data.
  const closed = closedMarket(collectionSlug)
  // UFC Strike across chains (2026-11-26, Trevor: "view this from a chain-agnostic view and … aggregate across
  // the multiple chains/wallets"): ONE value = Flow holdings (the wallet summary; headline + stale share, since
  // capped/stale snapshots land in the stale share) + Aptos holdings (/api/ufc/aptos-holdings). The Aptos half
  // is never silently missing: loading says so, a failed read says "not included", never a zero.
  if (isUfcAptosBinder(collectionSlug) && !loading) {
    const flowTotal = walletFmv === null ? null : walletFmv + (typeof staleFmv === "number" ? staleFmv : 0)
    const flowCount = momentCount ?? 0
    const aptosOk = ufcAptos?.status === "ok" ? ufcAptos : null
    const aptosCount = aptosOk?.count ?? 0
    const anyHeld = flowCount > 0 || aptosCount > 0
    // A Flow half that did not load leaves the total unknown (an em-dash), never the Aptos half alone.
    // Nothing priced on Aptos (totalFmv null) with nothing on Flow is unknown too, never $0.
    const aptosPart = aptosOk ? aptosOk.totalFmv : 0
    const total = !anyHeld || (flowCount > 0 && flowTotal === null) || (flowCount === 0 && aptosPart === null)
      ? null
      : (flowCount > 0 ? (flowTotal as number) : 0) + (aptosPart ?? 0)
    const parts: string[] = []
    if (flowCount > 0) parts.push(`${formatCount(flowCount)} on Flow`)
    if (aptosCount > 0) parts.push(`${formatCount(aptosCount)} on Aptos`)
    if (aptosOk && aptosOk.unpriced > 0) parts.push(`${formatCount(aptosOk.unpriced)} on Aptos without a current FMV, not in the total`)
    if (ufcAptos?.status === "loading") parts.push("Adding Aptos holdings…")
    if (ufcAptos?.status === "failed") parts.push("Aptos holdings couldn't load — not included")
    const caption = !anyHeld && ufcAptos?.status !== "loading" && ufcAptos?.status !== "failed"
      ? `No UFC Strike ${noun} found on Flow or on an Aptos account linked to this wallet`
      : parts.join(" · ")
    return (
      <div>
        <div className="rpc-stat-tile" data-testid="ufc-holdings-tile">
          <div className="rpc-stat-eyebrow">
            <span>Your Holdings · current FMV</span>
            {walletFmvAccessory}
          </div>
          <div className="rpc-stat-value">{total === null ? "—" : formatCurrency(total)}</div>
          <div className="rpc-stat-caption" style={{ lineHeight: 1.5 }}>{caption}</div>
        </div>
      </div>
    )
  }
  if (closed && !loading) {
    return (
      <div>
        <div className="rpc-stat-tile">
          <div className="rpc-stat-eyebrow">
            <span>Your Holdings</span>
            {walletFmvAccessory}
          </div>
          <div className="rpc-stat-value">{formatCount(momentCount)} {noun}</div>
          <div className="rpc-stat-caption" style={{ lineHeight: 1.5 }}>
            Market closed {formatClosedOn(closed.closedOn)} — no current total. Prices
            are the last values observed before the {closed.venue} market closed and
            are historical, not a portfolio value.
          </div>
        </div>
      </div>
    )
  }

  // 2026-11-24 (Trevor): "very simple and digestible, no subtext". One big value that covers the
  // whole wallet (the 11-22 one-number rule — the stale-priced share is IN it, not a caption), then
  // up to four plain stats. Every honesty rule still holds in the numbers themselves: null renders
  // "—", a real zero renders "$0", the unchecked-lock FMV is never added into Unlocked, and the
  // P&L only renders when it is the whole wallet's (PortfolioSummary passes null otherwise).
  const headline = walletFmv === null
    ? null
    : walletFmv + (typeof staleFmv === "number" && staleFmv > 0 ? staleFmv : 0)

  type Stat = { key: string; label: string; value: string; tone?: "up" | "down"; title?: string }
  const stats: Stat[] = [
    { key: "count", label: noun === "pins" ? "Pins" : "Moments", value: formatCount(momentCount) },
  ]
  // ⛔ Moments whose lock state was never checked are NOT in Unlocked (register #112) — that figure
  // is what the collector is told they could sell. Named on hover rather than as a caption line.
  if (hasLocking) stats.push({
    key: "unlocked",
    label: "Unlocked",
    value: formatUsdWhole(unlockedFmv),
    title: lockUnknownCount != null && lockUnknownCount > 0
      ? formatCount(lockUnknownCount) + " " + noun + " not checked yet" + (lockUnknownFmv != null ? " (" + formatCurrency(lockUnknownFmv) + ")" : "") + " — not counted here"
      : undefined,
  })
  stats.push({ key: "offers", label: "Top offers", value: formatUsdWhole(bestOfferTotal) })
  if (pnl) {
    const pct = Number.isFinite(pnl.pct) ? " (" + (pnl.pct >= 0 ? "+" : "") + Math.round(pnl.pct) + "%)" : ""
    stats.push({
      key: "pnl",
      label: "Profit / Loss",
      value: (pnl.amount >= 0 ? "+" : "") + formatUsdWhole(pnl.amount) + pct,
      tone: pnl.amount >= 0 ? "up" : "down",
    })
  }

  // The bar spans the WHOLE count, not just the rows whose source is known (2026-11-24: a Pinnacle
  // wallet of 187 pins drew one full-width "Packs 31" bar — 100 % packs, a claim about 156 pins
  // nobody knew the source of). The unknown remainder is its own grey "Other" share.
  const src = acquisition && acquisition.total > 0 ? acquisition : null
  const known = src ? src.packs + src.market + src.rewards + (src.gifts ?? 0) : 0
  const other = src && typeof momentCount === "number" && momentCount > known ? momentCount - known : 0
  const segments = src
    ? [
        { key: "packs", label: "Packs", n: src.packs, color: "rgb(20,184,166)" },
        { key: "market", label: "Market", n: src.market, color: "var(--rpc-text-secondary)" },
        { key: "rewards", label: "Rewards", n: src.rewards, color: "rgb(245,158,11)" },
        { key: "gifts", label: "Gifts", n: src.gifts ?? 0, color: "rgb(168,85,247)" },
        { key: "other", label: "Other", n: other, color: "var(--rpc-border-hover)" },
      ].filter(function(seg) { return seg.n > 0 })
    : []
  const segTotal = segments.reduce(function(a, seg) { return a + seg.n }, 0)

  return (
    <div>
      <section className="rpc-binder-hero" data-testid="binder-hero" aria-label="Collection value">
        <div className="rpc-binder-hero-label">
          <span>Collection value</span>
          {loading && <PulseDot />}
          {walletFmvAccessory}
        </div>
        <div className="rpc-binder-hero-value" data-testid="binder-hero-value">{formatUsdWhole(headline)}</div>
        {showProgress ? (
          <div style={{ marginTop: 10, maxWidth: 320 }} className="rpc-stat-caption">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>Loading {formatCount(loadProgress.loaded)} / {formatCount(loadProgress.total)} {noun}</span>
              <span>·</span>
              <span>{loadProgress.pct}%</span>
            </div>
            <div style={{ marginTop: 4, height: 3, width: "100%", background: "var(--rpc-border)", borderRadius: 2, overflow: "hidden" }}>
              <div style={{ height: "100%", width: Math.max(0, Math.min(100, loadProgress.pct)) + "%", background: "var(--rpc-red)", transition: "width 0.3s" }} />
            </div>
          </div>
        ) : null}

        <div className="rpc-binder-hero-stats" data-cols={String(stats.length)}>
          {stats.map(function(st) {
            return (
              <div key={st.key} className="rpc-binder-hero-stat" data-testid={"binder-stat-" + st.key} title={st.title}>
                <div className="rpc-binder-hero-stat-label">{st.label}</div>
                <div className={"rpc-binder-hero-stat-value" + (st.tone ? " rpc-binder-hero-stat-value--" + st.tone : "")}>{st.value}</div>
              </div>
            )
          })}
        </div>

        {segTotal > 0 ? (
          <div className="rpc-binder-source" data-testid="binder-source">
            <div className="rpc-binder-source-bar" role="img" aria-label={segments.map(function(seg) { return seg.label + " " + formatCount(seg.n) }).join(", ")}>
              {segments.map(function(seg) {
                return <span key={seg.key} style={{ flexGrow: seg.n, flexBasis: 0, minWidth: 4, background: seg.color }} />
              })}
            </div>
            <div className="rpc-binder-source-legend" aria-hidden="true">
              {segments.map(function(seg) {
                return (
                  <span key={seg.key}>
                    <i className="rpc-binder-source-dot" style={{ background: seg.color }} />
                    {seg.label} {formatCount(seg.n)}
                  </span>
                )
              })}
            </div>
          </div>
        ) : null}
      </section>
      <div style={{ marginTop: 8 }}>
        <FmvDisclaimer variant="short" />
      </div>
    </div>
  )
}
