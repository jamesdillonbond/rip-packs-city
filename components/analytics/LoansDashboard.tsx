"use client"

import { useEffect, useMemo, useState } from "react"
import {
  HandCoins,
  DollarSign,
  Users,
  Activity,
  Percent,
  CircleDollarSign,
  TimerReset,
  ShieldCheck,
  Coins,
} from "lucide-react"
import KpiCard from "./KpiCard"
import HealthBar from "./HealthBar"
import VolumeChart from "./VolumeChart"
import NewWalletsChart from "./NewWalletsChart"
import CohortRetention from "./CohortRetention"
import LeaderboardTable, { type LeaderboardDisplayRow } from "./LeaderboardTable"
import FilterBar, { type LoanWindow } from "./FilterBar"
import ExploreSection from "./ExploreSection"
import type {
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesRow,
  AnalyticsNewWalletsRow,
  AnalyticsCohortRow,
  AnalyticsLimboSummary,
} from "@/lib/analytics-types"

const COLLECTIONS: Array<{ key: string; label: string }> = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "Golazos" },
  { key: "pinnacle", label: "Pinnacle" },
]

interface TimeseriesResponse {
  rows: AnalyticsTimeseriesRow[]
  bucket: "auto" | "day" | "week"
}

interface NewWalletsResponse {
  rows: AnalyticsNewWalletsRow[]
}

interface CohortsResponse {
  role: string
  rows: AnalyticsCohortRow[]
}

interface LeaderboardResponse {
  role: string
  rows: LeaderboardDisplayRow[]
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function formatPct(n: number | null | undefined, fallback = "—"): string {
  if (n == null || !Number.isFinite(n)) return fallback
  return `${n.toFixed(1)}%`
}

// Compute % delta between current and prior values. Returns null when there
// is no usable signal — caller should suppress the indicator entirely in
// that case (we don't want to render "+0%" or "—" as a fake delta).
function deltaPct(curr: number | null | undefined, prev: number | null | undefined): number | null {
  if (curr == null || prev == null || !Number.isFinite(curr) || !Number.isFinite(prev)) return null
  if (prev <= 0) return null
  return Math.round(((curr - prev) / prev) * 1000) / 10
}

function buildQs(window: LoanWindow, collections: string[]): string {
  const qs = new URLSearchParams()
  qs.set("window", window)
  if (collections.length > 0) qs.set("collections", collections.join(","))
  return qs.toString()
}

export default function LoansDashboard() {
  const [window, setWindow] = useState<LoanWindow>("all")
  const [activeCollections, setActiveCollections] = useState<string[]>([])

  const [summary, setSummary] = useState<AnalyticsSummaryResponse | null>(null)
  const [limbo, setLimbo] = useState<AnalyticsLimboSummary | null>(null)
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null)
  const [newWallets, setNewWallets] = useState<NewWalletsResponse | null>(null)
  const [cohorts, setCohorts] = useState<CohortsResponse | null>(null)
  const [topLenders, setTopLenders] = useState<LeaderboardResponse | null>(null)
  const [topBorrowers, setTopBorrowers] = useState<LeaderboardResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = buildQs(window, activeCollections)
    const collectionsQs = activeCollections.length > 0 ? `?collections=${activeCollections.join(",")}` : ""

    const calls: Array<Promise<unknown>> = [
      fetch(`/api/analytics/loans/summary?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/limbo-summary${collectionsQs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/timeseries?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/new-wallets?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/cohorts${collectionsQs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/leaderboard?role=lender&${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/leaderboard?role=borrower&${qs}`).then((r) => r.json()),
    ]

    Promise.all(calls)
      .then(([s, lb, ts, nw, ch, tl, tb]) => {
        if (cancelled) return
        setSummary(s as AnalyticsSummaryResponse | null)
        setLimbo(lb as AnalyticsLimboSummary | null)
        setTimeseries(ts as TimeseriesResponse)
        setNewWallets(nw as NewWalletsResponse)
        setCohorts(ch as CohortsResponse)
        setTopLenders(tl as LeaderboardResponse)
        setTopBorrowers(tb as LeaderboardResponse)
        setRefreshedAt(new Date().toISOString())
      })
      .catch(() => {
        // soft-fail — components render their own empty states
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [window, activeCollections])

  const windowLabel = useMemo(() => {
    switch (window) {
      case "l7":
        return "Last 7 days"
      case "l30":
        return "Last 30 days"
      case "l90":
        return "Last 90 days"
      case "ytd":
        return "Year to date"
      case "y2026":
        return "2026"
      case "y2025":
        return "2025"
      default:
        return "All time"
    }
  }, [window])

  const prior = summary?.prior_period ?? null

  const volumeDelta = deltaPct(summary?.total_principal_usd, prior?.total_principal_usd)
  const loansDelta = deltaPct(summary?.total_loans, prior?.total_loans)
  const lendersDelta = deltaPct(summary?.unique_lenders, prior?.unique_lenders)
  const borrowersDelta = deltaPct(summary?.unique_borrowers, prior?.unique_borrowers)
  const outstandingDelta = deltaPct(summary?.outstanding_principal, prior?.outstanding_principal)
  const interestDelta = deltaPct(
    (summary?.avg_interest_rate ?? null) != null ? (summary!.avg_interest_rate as number) * 100 : null,
    (prior?.avg_interest_rate ?? null) != null ? (prior!.avg_interest_rate as number) * 100 : null
  )

  const lenderRepeatPct = summary?.lender_repeat_pct ?? null
  const borrowerRepeatPct = summary?.borrower_repeat_pct ?? null

  const lenderSubtitle =
    lenderRepeatPct != null && summary && summary.unique_lenders > 0
      ? `${formatPct(lenderRepeatPct)} returning`
      : summary
        ? `${formatNumber(summary.unique_lenders)} originators`
        : undefined
  const borrowerSubtitle =
    borrowerRepeatPct != null && summary && summary.unique_borrowers > 0
      ? `${formatPct(borrowerRepeatPct)} returning`
      : summary
        ? `${formatNumber(summary.unique_borrowers)} originators`
        : undefined

  const interestRatePct =
    summary?.avg_interest_rate != null
      ? Math.round(summary.avg_interest_rate * 1000) / 10 // *100, 1-decimal
      : null
  const avgTermDays = summary?.avg_term_days ?? null

  return (
    <div className="space-y-8">
      <FilterBar
        title="Flowty Loan Analytics"
        subtitle="Live capital flow on Flowty NFT-collateralized loans. Data refreshes every 10 minutes."
        collections={COLLECTIONS}
        activeCollections={activeCollections}
        onCollectionsChange={setActiveCollections}
        window={window}
        onWindowChange={setWindow}
      />

      <section className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Total volume"
          value={summary ? formatUsd(summary.total_principal_usd) : "—"}
          sublabel={summary ? `${formatNumber(summary.total_loans)} loans` : undefined}
          delta={volumeDelta}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiCard
          label="Loan count"
          value={summary ? formatNumber(summary.total_loans) : "—"}
          sublabel={windowLabel}
          delta={loansDelta}
          icon={HandCoins}
          accent="sky"
        />
        <KpiCard
          label="Unique lenders"
          value={summary ? formatNumber(summary.unique_lenders) : "—"}
          sublabel={lenderSubtitle}
          delta={lendersDelta}
          icon={Users}
          accent="sky"
        />
        <KpiCard
          label="Unique borrowers"
          value={summary ? formatNumber(summary.unique_borrowers) : "—"}
          sublabel={borrowerSubtitle}
          delta={borrowersDelta}
          icon={Users}
          accent="amber"
        />
        <KpiCard
          label="Outstanding active"
          value={summary ? formatUsd(summary.outstanding_principal) : "—"}
          sublabel={
            summary ? `${formatNumber(summary.active_loans_count)} active loans` : undefined
          }
          delta={outstandingDelta}
          icon={Coins}
          accent="emerald"
        />
        <KpiCard
          label="Avg interest rate"
          value={interestRatePct != null ? `${interestRatePct.toFixed(1)}%` : "—"}
          sublabel={
            avgTermDays != null ? `${Math.round(avgTermDays)}d avg term` : undefined
          }
          delta={interestDelta}
          icon={Percent}
          accent="rose"
        />
      </section>

      {/* Limbo recovery strip — pre-pause loans whose terminal event landed
          inside our backfill window. Mixing them with originated-in-window
          KPIs above was the main source of inflated numbers, so they get
          their own row. */}
      <section className="rounded-xl border border-emerald-900/40 bg-gradient-to-br from-emerald-950/40 to-slate-950/40 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3 max-w-2xl">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20 flex-shrink-0">
              <ShieldCheck size={16} className="text-emerald-400" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-emerald-400 font-semibold mb-1">
                Limbo recovery cohort
              </div>
              <h2 className="text-lg font-semibold text-slate-100">
                {limbo
                  ? `${formatNumber(limbo.total_loans)} pre-pause loans recovered`
                  : "—"}
              </h2>
              <p className="text-sm text-slate-400 mt-1 leading-relaxed">
                Loans funded before the Dec 28 2025 exploit pause that reached terminal state
                inside our indexed window. Tracked separately so they don&apos;t inflate
                originated-in-window metrics.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 lg:flex-shrink-0 lg:max-w-xl">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Repayment rate
              </div>
              <div className="text-xl font-semibold text-emerald-400 tabular-nums">
                {limbo ? formatPct(limbo.repayment_rate_pct) : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Repaid
              </div>
              <div className="text-xl font-semibold text-slate-100 tabular-nums">
                {limbo ? formatNumber(limbo.repaid_count) : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Settled
              </div>
              <div className="text-xl font-semibold text-slate-100 tabular-nums">
                {limbo ? formatNumber(limbo.settled_count) : "—"}
              </div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Cancelled
              </div>
              <div className="text-xl font-semibold text-slate-100 tabular-nums">
                {limbo ? formatNumber(limbo.canceled_count) : "—"}
              </div>
            </div>
          </div>
        </div>
      </section>

      <HealthBar
        title="Live loan book"
        metrics={[
          {
            label: "Active loans",
            value: summary ? formatNumber(summary.active_loans_count) : "—",
            hint: "Currently funded",
          },
          {
            label: "Outstanding principal",
            value: summary ? formatUsd(summary.outstanding_principal) : "—",
          },
          {
            label: "Open listings",
            value: summary ? formatNumber(summary.open_listings_count) : "—",
            hint: summary ? `${formatUsd(summary.open_listings_principal)} principal` : undefined,
          },
          {
            label: "Settled (default proxy)",
            value: summary ? formatNumber(summary.settled_count) : "—",
            hint: "Lifetime",
          },
        ]}
      />

      <section className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Volume over time</h2>
            <p className="text-xs text-slate-500">
              Stacked by collection · {windowLabel}
            </p>
          </div>
        </div>
        <VolumeChart
          rows={timeseries?.rows ?? []}
          activeCollections={activeCollections}
          weekly={timeseries?.bucket === "week"}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-1 xl:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold text-slate-100 mb-1">New wallet acquisition</h2>
          <p className="text-xs text-slate-500 mb-4">
            Weekly first-time lenders and borrowers · cumulative on right axis
          </p>
          <NewWalletsChart rows={newWallets?.rows ?? []} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-100 mb-1">Cohort retention</h2>
          <p className="text-xs text-slate-500 mb-4">
            Monthly cohorts · % of cohort active in subsequent months
          </p>
          <CohortRetention rows={cohorts?.rows ?? []} />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <LeaderboardTable
          rows={topLenders?.rows ?? []}
          role="lender"
          window={windowLabel}
        />
        <LeaderboardTable
          rows={topBorrowers?.rows ?? []}
          role="borrower"
          window={windowLabel}
        />
      </section>

      <ExploreSection
        title="Per-collection drill-downs"
        items={[
          {
            label: "Top Shot Loans",
            description: "Loan book against NBA Top Shot moments.",
          },
          {
            label: "NFL All Day Loans",
            description: "Loan book against NFL All Day moments.",
          },
          {
            label: "Golazos Loans",
            description: "Loan book against LaLiga Golazos moments.",
          },
          {
            label: "Pinnacle Loans",
            description: "Loan book against Disney Pinnacle pins.",
          },
        ]}
      />

      <footer className="flex flex-wrap items-center gap-3 text-xs text-slate-500 pt-2 border-t border-slate-800">
        <span className="inline-flex items-center gap-1.5">
          <Activity size={12} className="text-emerald-500" />
          {loading ? "Refreshing…" : refreshedAt ? `Refreshed ${new Date(refreshedAt).toLocaleTimeString()}` : "Idle"}
        </span>
        <span className="text-slate-700">·</span>
        <a
          href="/analytics/methodology/loans"
          className="hover:text-emerald-400 transition-colors inline-flex items-center gap-1"
        >
          <Percent size={12} />
          Methodology
        </a>
        <span className="text-slate-700">·</span>
        <span className="inline-flex items-center gap-1.5">
          <CircleDollarSign size={12} />
          USD-pegged token volumes (USDCf, USDC, FUSD, TUSDT, DUC)
        </span>
        <span className="text-slate-700">·</span>
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          10-min refresh
        </span>
      </footer>
    </div>
  )
}
