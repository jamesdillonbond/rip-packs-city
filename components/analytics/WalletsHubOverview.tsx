"use client"

import { useEffect, useState } from "react"
import {
  Activity,
  CircleDollarSign,
  Clock,
  HandCoins,
  Info,
  Users,
  Wallet,
} from "lucide-react"
import KpiCard from "./KpiCard"
import type { WalletsOverviewResponse } from "@/lib/analytics-types"

const SEGMENT_COLORS: Record<string, string> = {
  whale: "#a78bfa",
  active: "#34d399",
  casual: "#60a5fa",
  dust: "#a1a1aa",
}

const SEGMENT_LABEL: Record<string, string> = {
  whale: "Whales",
  active: "Active",
  casual: "Casual",
  dust: "Dust",
}

const SEGMENT_CAPTION: Record<string, string> = {
  whale: "Whale: $50K+ peak volume.",
  active: "Active: $5K+.",
  casual: "Casual: $100+.",
  dust: "Dust: under $100.",
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

export default function WalletsHubOverview() {
  const [data, setData] = useState<WalletsOverviewResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    fetch("/api/analytics/wallets/overview")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        if (j && j.totals && j.segments) {
          setData(j as WalletsOverviewResponse)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (loading && !data) {
    return (
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-6 text-center text-sm text-zinc-500">
        Loading wallet overview…
      </section>
    )
  }
  if (!data) return null

  const { totals, segments } = data
  const totalSegments =
    (segments.whale || 0) +
    (segments.active || 0) +
    (segments.casual || 0) +
    (segments.dust || 0)

  const activeCount =
    (totals.last_active_within_24h || 0) +
    Math.max(
      0,
      (totals.last_active_within_7d || 0) - (totals.last_active_within_24h || 0)
    )
  const totalActiveLoans =
    Math.round(
      (totals.avg_loans_per_borrower || 0) * (totals.borrowers || 0)
    ) +
    Math.round(
      (totals.avg_loans_per_lender || 0) * (totals.lenders || 0)
    )
  const activeForAvg =
    (totals.last_active_within_7d || 0) > 0
      ? totals.last_active_within_7d
      : totals.wallets_total
  const avgLoansActive =
    activeForAvg > 0 ? totalActiveLoans / activeForAvg : 0

  return (
    <section className="space-y-6">
      <div className="flex items-end justify-between">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">Wallets hub</h2>
          <p className="text-xs text-zinc-500">
            Loan-book wallet directory roll-up — totals, segments by peak
            volume, and activity recency
          </p>
        </div>
      </div>

      {/* KPI strip */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Total wallets"
          value={formatNumber(totals.wallets_total)}
          sublabel={`${formatNumber(totals.borrowers)} borrowers · ${formatNumber(totals.lenders)} lenders`}
          accent="emerald"
          icon={Wallet}
        />
        <KpiCard
          label="Active 7d"
          value={formatNumber(totals.last_active_within_7d)}
          sublabel={`${formatNumber(totals.last_active_within_24h)} active in last 24h`}
          accent="sky"
          icon={Activity}
        />
        <KpiCard
          label="Total volume"
          value={formatUsd(totals.total_borrowed_usd)}
          sublabel="Borrowed = lent (platform invariant)"
          accent="amber"
          icon={CircleDollarSign}
        />
        <KpiCard
          label="Avg loans / active wallet"
          value={avgLoansActive.toFixed(1)}
          sublabel={`Across ${formatNumber(activeForAvg)} active wallets`}
          accent="rose"
          icon={HandCoins}
        />
      </div>

      {/* Segment breakdown */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-baseline justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-100">
            Volume tier segments
          </h3>
          <span className="text-xs text-zinc-500">
            {formatNumber(totalSegments)} wallets
          </span>
        </div>

        {totalSegments > 0 ? (
          <>
            <div className="flex h-3 w-full overflow-hidden rounded border border-zinc-800">
              {(["whale", "active", "casual", "dust"] as const).map((k) => {
                const v = (segments as any)[k] as number
                const pct = totalSegments > 0 ? (v / totalSegments) * 100 : 0
                if (pct <= 0) return null
                return (
                  <div
                    key={k}
                    style={{ width: `${pct}%`, backgroundColor: SEGMENT_COLORS[k] }}
                    title={`${SEGMENT_LABEL[k]} · ${v} wallets (${pct.toFixed(1)}%)`}
                  />
                )
              })}
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {(["whale", "active", "casual", "dust"] as const).map((k) => {
                const v = (segments as any)[k] as number
                return (
                  <div
                    key={k}
                    className="flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-2.5"
                  >
                    <span
                      className="inline-block h-2.5 w-2.5 mt-1 rounded-sm"
                      style={{ backgroundColor: SEGMENT_COLORS[k] }}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-baseline gap-1.5">
                        <span className="text-sm font-semibold text-zinc-100">
                          {SEGMENT_LABEL[k]}
                        </span>
                        <span className="text-xs text-zinc-300 tabular-nums">
                          {v}
                        </span>
                      </div>
                      <p className="text-[10px] text-zinc-500 leading-snug">
                        {SEGMENT_CAPTION[k]}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        ) : (
          <div className="text-sm text-zinc-500">No segment data available.</div>
        )}
      </div>

      {/* Roles + activity */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold text-zinc-100">Role split</h3>
            <Users size={14} className="text-zinc-500" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
              <div className="text-[10px] uppercase tracking-widest text-sky-400 font-semibold">
                Borrowers
              </div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {formatNumber(totals.borrowers)}
              </div>
            </div>
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="text-[10px] uppercase tracking-widest text-emerald-400 font-semibold">
                Lenders
              </div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {formatNumber(totals.lenders)}
              </div>
            </div>
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
              <div className="text-[10px] uppercase tracking-widest text-amber-400 font-semibold">
                Both
              </div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {formatNumber(totals.both_roles)}
              </div>
            </div>
          </div>
          <div className="mt-3 flex items-start gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-2.5">
            <Info size={12} className="text-zinc-500 mt-0.5 flex-shrink-0" />
            <p className="text-[11px] text-zinc-500 leading-snug">
              &quot;Both&quot; wallets count once in <em>Total wallets</em> but
              appear in both role buckets. Borrowers + lenders − both ={" "}
              {formatNumber(
                (totals.borrowers || 0) +
                  (totals.lenders || 0) -
                  (totals.both_roles || 0)
              )}
              , matching the directory total.
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h3 className="text-sm font-semibold text-zinc-100">
              Activity recency
            </h3>
            <Clock size={14} className="text-zinc-500" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-md border border-emerald-500/30 bg-emerald-500/5 p-3">
              <div className="text-[10px] uppercase tracking-widest text-emerald-400 font-semibold">
                24h
              </div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {formatNumber(totals.last_active_within_24h)}
              </div>
            </div>
            <div className="rounded-md border border-sky-500/30 bg-sky-500/5 p-3">
              <div className="text-[10px] uppercase tracking-widest text-sky-400 font-semibold">
                7d
              </div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {formatNumber(totals.last_active_within_7d)}
              </div>
            </div>
            <div className="rounded-md border border-zinc-700 bg-zinc-800/40 p-3">
              <div className="text-[10px] uppercase tracking-widest text-zinc-400 font-semibold">
                Dormant 30d+
              </div>
              <div className="text-2xl font-bold text-zinc-100 tabular-nums">
                {formatNumber(totals.dormant_30d)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
