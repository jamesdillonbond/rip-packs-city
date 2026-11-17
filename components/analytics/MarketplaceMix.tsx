"use client"

// Marketplace mix — renders the distribution of sale volume across the
// three marketplaces we index (Top Shot's centralized market, Flowty,
// and on-chain Pinnacle.Trade). Stacked-bar form so the legend can
// surface the dollar volume per slice without the cramming a pie chart.
//
// The pure bucketing/formatting logic lives in
// lib/analytics-marketplace-mix-compute.ts so the coverage ratchet can see it.

import {
  buildMarketplaceMix,
  formatMixCount,
  formatMixUsd,
  sliceWidthPct,
  type MarketplaceMixData,
} from "@/lib/analytics-marketplace-mix-compute"

interface MarketplaceMixProps {
  // Keys: "topshot", "flowty", "on-chain" (or "pinnacle"). The summary RPC
  // emits one of these. We tolerate any unknown extras and bucket them
  // into "other".
  data: MarketplaceMixData
}

export default function MarketplaceMix({ data }: MarketplaceMixProps) {
  const result = buildMarketplaceMix(data)

  if (result.kind === "empty") {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-sm text-[color:var(--rpc-text-muted)]">
        No marketplace activity in this window yet.
      </div>
    )
  }

  if (result.kind === "no-volume") {
    return (
      <div className="flex h-32 items-center justify-center rounded-xl border border-dashed border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] text-sm text-[color:var(--rpc-text-muted)]">
        No marketplace volume in this window yet.
      </div>
    )
  }

  const { slices, total } = result

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Marketplace mix</h2>
        <div className="text-xs text-[color:var(--rpc-text-muted)] tabular-nums">{formatMixUsd(total)} total</div>
      </div>
      <p className="text-xs text-[color:var(--rpc-text-muted)] mb-4">
        Where the volume came from. Top Shot’s centralized market, Flowty (NFTStorefrontV2 fork), and direct
        on-chain Pinnacle sales.
      </p>
      <div className="flex h-3 w-full overflow-hidden rounded">
        {slices.map((s) => (
          <div
            key={s.key}
            className={s.className}
            style={{ width: `${sliceWidthPct(s.usd, total)}%` }}
            title={`${s.label}: ${formatMixUsd(s.usd)} · ${formatMixCount(s.count)} sales`}
          />
        ))}
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {slices.map((s) => {
          const pct = (s.usd / total) * 100
          return (
            <li
              key={s.key}
              className="flex items-center gap-2.5 rounded-md border border-[color:var(--rpc-border-subtle)] bg-[color:var(--rpc-surface-raised)] px-3 py-2"
            >
              <span
                className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                style={{ background: s.color }}
              />
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium text-[color:var(--rpc-text-secondary)] truncate">{s.label}</div>
                <div className="text-[10px] text-[color:var(--rpc-text-muted)] tabular-nums">
                  {formatMixCount(s.count)} sales
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-semibold text-[color:var(--rpc-text-primary)] tabular-nums">
                  {formatMixUsd(s.usd)}
                </div>
                <div className="text-[10px] text-[color:var(--rpc-text-muted)] tabular-nums">{pct.toFixed(1)}%</div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
