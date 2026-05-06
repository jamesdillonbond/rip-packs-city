"use client"

import type { ReactNode } from "react"
import { formatCurrency, formatCount } from "@/lib/format"

// Shared four-tile wallet analytics row used by every collection's
// /[collection]/collection page (and the standalone Pinnacle page until
// it migrates onto the dynamic route).
//
// Value semantics:
//   null  → em-dash ("—") — not loaded yet OR concept doesn't apply
//   0     → "$0"          — real, computed zero (e.g. wallet has no locked moments)
//   N     → "$N" with thousands separators
//
// For Pinnacle (no locking concept), the route returns null for
// lockedFmv + lockedCount so the Locked tile renders em-dash without a
// misleading "0 locked" caption.
//
// loadProgress is optional. When provided AND loaded < total, the
// Wallet FMV caption swaps from "N moments" to a small progress bar
// showing how much of the wallet has been hydrated.

export type WalletStatRowProps = {
  walletFmv: number | null
  unlockedFmv: number | null
  lockedFmv: number | null
  bestOfferTotal: number | null
  momentCount: number | null
  unlockedCount: number | null
  lockedCount: number | null
  spreadGap: number | null
  collectionSlug: string
  loading?: boolean
  loadProgress?: { loaded: number; total: number; pct: number } | null
  walletFmvAccessory?: ReactNode
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

function unitNoun(slug: string): string {
  return slug === "disney-pinnacle" ? "pins" : "moments"
}

function lockedCaption(count: number | null): string {
  if (count === null) return "n/a for this collection"
  return formatCount(count) + " locked"
}

function unlockedCaption(count: number | null): string {
  if (count === null) return "—"
  return formatCount(count) + " unlocked"
}

export default function WalletStatRow(props: WalletStatRowProps) {
  const {
    walletFmv,
    unlockedFmv,
    lockedFmv,
    bestOfferTotal,
    momentCount,
    unlockedCount,
    lockedCount,
    spreadGap,
    collectionSlug,
    loading,
    loadProgress,
    walletFmvAccessory,
  } = props

  const showProgress = loadProgress && loadProgress.loaded < loadProgress.total
  const noun = unitNoun(collectionSlug)

  // Best Offer caption: only render the FMV gap when both sides are
  // genuinely-positive numbers; otherwise stay quiet.
  const showSpreadGap =
    typeof walletFmv === "number" && walletFmv > 0 &&
    typeof bestOfferTotal === "number" && bestOfferTotal > 0 &&
    typeof spreadGap === "number"

  return (
    <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
      <div className="rpc-stat-tile">
        <div className="rpc-stat-eyebrow">
          <span>Wallet FMV</span>
          {loading && <PulseDot />}
          {walletFmvAccessory}
        </div>
        <div className="rpc-stat-value">{formatCurrency(walletFmv)}</div>
        {showProgress ? (
          <div className="rpc-stat-caption">
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span>{formatCount(loadProgress.loaded)} / {formatCount(loadProgress.total)} {noun}</span>
              <span>·</span>
              <span>{loadProgress.pct}%</span>
            </div>
            <div
              style={{
                marginTop: 4,
                height: 2,
                width: "100%",
                background: "var(--rpc-border)",
                borderRadius: 1,
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: Math.max(0, Math.min(100, loadProgress.pct)) + "%",
                  background: "var(--rpc-red)",
                  transition: "width 0.3s",
                }}
              />
            </div>
          </div>
        ) : (
          <div className="rpc-stat-caption">{formatCount(momentCount)} {noun}</div>
        )}
      </div>

      <div className="rpc-stat-tile">
        <div className="rpc-stat-eyebrow">
          <span>Unlocked FMV</span>
          {loading && <PulseDot />}
        </div>
        <div className="rpc-stat-value">{formatCurrency(unlockedFmv)}</div>
        <div className="rpc-stat-caption">{unlockedCaption(unlockedCount)}</div>
      </div>

      <div className="rpc-stat-tile">
        <div className="rpc-stat-eyebrow">
          <span>Locked FMV</span>
          {loading && <PulseDot />}
        </div>
        <div className="rpc-stat-value">{formatCurrency(lockedFmv)}</div>
        <div className="rpc-stat-caption">{lockedCaption(lockedCount)}</div>
      </div>

      <div className="rpc-stat-tile">
        <div className="rpc-stat-eyebrow">Best Offer Total</div>
        <div className="rpc-stat-value">{formatCurrency(bestOfferTotal)}</div>
        <div className="rpc-stat-caption">
          {showSpreadGap ? "vs FMV: " + formatCurrency(-(spreadGap as number)) : ""}
        </div>
      </div>
    </div>
  )
}
