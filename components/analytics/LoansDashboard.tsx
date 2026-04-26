"use client"

import { useEffect, useMemo, useState } from "react"
import {
  HandCoins,
  DollarSign,
  Users,
  UserPlus,
  Activity,
  Percent,
  CircleDollarSign,
  TimerReset,
} from "lucide-react"
import KpiCard from "./KpiCard"
import HealthBar from "./HealthBar"
import VolumeChart, { type VolumePoint } from "./VolumeChart"
import NewWalletsChart, { type NewWalletPoint } from "./NewWalletsChart"
import CohortRetention from "./CohortRetention"
import LeaderboardTable from "./LeaderboardTable"
import FilterBar, { type LoanWindow } from "./FilterBar"
import ExploreSection from "./ExploreSection"

const COLLECTIONS: Array<{ key: string; label: string }> = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "Golazos" },
  { key: "pinnacle", label: "Pinnacle" },
]

interface SummaryResponse {
  totalLoans: number
  totalUsd: number
  uniqueLenders: number
  uniqueBorrowers: number
  newWallets: number
  deltas: {
    totalLoansPct: number | null
    totalUsdPct: number | null
    uniqueLendersPct: number | null
    uniqueBorrowersPct: number | null
    newWalletsPct: number | null
  }
  lenderRepeatPct: number
  borrowerRepeatPct: number
  activeCount: number
  outstandingUsd: number
  avgInterestRate: number | null
  settledCount: number
  generatedAt: string
}

interface TimeseriesResponse {
  weekly: boolean
  collections: string[]
  points: VolumePoint[]
}

interface NewWalletsResponse {
  points: NewWalletPoint[]
}

interface CohortsResponse {
  cohorts: Array<{
    cohort: string
    cohortLabel: string
    size: number
    retention: Array<{ quarter: string; pct: number; count: number }>
  }>
  quarters: string[]
}

interface LeaderboardResponse {
  rows: Array<{
    rank: number
    address: string
    username: string
    loanCount: number
    totalUsd: number
    isReturning: boolean
  }>
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function formatPct(n: number | null | undefined, fallback = "—"): string {
  if (n == null || !Number.isFinite(n)) return fallback
  return `${n.toFixed(1)}%`
}

function buildQs(window: LoanWindow, collections: string[]): string {
  const qs = new URLSearchParams()
  qs.set("window", window)
  if (collections.length > 0) qs.set("collections", collections.join(","))
  return qs.toString()
}

export default function LoansDashboard() {
  const [window, setWindow] = useState<LoanWindow>("ALL")
  const [activeCollections, setActiveCollections] = useState<string[]>([])

  const [summary, setSummary] = useState<SummaryResponse | null>(null)
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

    const calls = [
      fetch(`/api/analytics/loans/summary?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/timeseries?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/new-wallets?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/cohorts?${buildQs(window, activeCollections)}`).then((r) =>
        r.json()
      ),
      fetch(`/api/analytics/loans/leaderboard?role=lender&${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/leaderboard?role=borrower&${qs}`).then((r) => r.json()),
    ]

    Promise.all(calls)
      .then(([s, ts, nw, ch, tl, tb]) => {
        if (cancelled) return
        setSummary(s as SummaryResponse)
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
      case "L7":
        return "Last 7 days"
      case "L30":
        return "Last 30 days"
      case "L90":
        return "Last 90 days"
      case "YTD":
        return "Year to date"
      case "2026":
        return "2026"
      case "2025":
        return "2025"
      default:
        return "All time"
    }
  }, [window])

  const lenderSubtitle =
    summary && summary.uniqueLenders > 0
      ? `${formatPct(summary.lenderRepeatPct)} returning`
      : "—"
  const borrowerSubtitle =
    summary && summary.uniqueBorrowers > 0
      ? `${formatPct(summary.borrowerRepeatPct)} returning`
      : "—"

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

      <section className="grid gap-3 grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Loan volume"
          value={summary ? formatUsd(summary.totalUsd) : "—"}
          sublabel={summary ? `${formatNumber(summary.totalLoans)} loans` : undefined}
          delta={summary?.deltas.totalUsdPct}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiCard
          label="Unique lenders"
          value={summary ? formatNumber(summary.uniqueLenders) : "—"}
          sublabel={lenderSubtitle}
          delta={summary?.deltas.uniqueLendersPct}
          icon={Users}
          accent="sky"
        />
        <KpiCard
          label="Unique borrowers"
          value={summary ? formatNumber(summary.uniqueBorrowers) : "—"}
          sublabel={borrowerSubtitle}
          delta={summary?.deltas.uniqueBorrowersPct}
          icon={HandCoins}
          accent="amber"
        />
        <KpiCard
          label="New wallets"
          value={summary ? formatNumber(summary.newWallets) : "—"}
          sublabel={windowLabel}
          delta={summary?.deltas.newWalletsPct}
          icon={UserPlus}
          accent="rose"
        />
      </section>

      <HealthBar
        title="Live loan book"
        metrics={[
          {
            label: "Active loans",
            value: summary ? formatNumber(summary.activeCount) : "—",
            hint: "Currently funded",
          },
          {
            label: "Outstanding principal",
            value: summary ? formatUsd(summary.outstandingUsd) : "—",
          },
          {
            label: "Avg interest rate",
            value:
              summary && summary.avgInterestRate != null
                ? formatPct(summary.avgInterestRate)
                : "—",
          },
          {
            label: "Settled (default proxy)",
            value: summary ? formatNumber(summary.settledCount) : "—",
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
          series={timeseries?.points ?? []}
          collections={timeseries?.collections ?? []}
          weekly={timeseries?.weekly ?? false}
        />
      </section>

      <section className="grid gap-6 lg:grid-cols-1 xl:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
          <h2 className="text-lg font-semibold text-slate-100 mb-1">New wallet acquisition</h2>
          <p className="text-xs text-slate-500 mb-4">
            Weekly first-time lenders and borrowers · cumulative on right axis
          </p>
          <NewWalletsChart series={newWallets?.points ?? []} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-100 mb-1">Cohort retention</h2>
          <p className="text-xs text-slate-500 mb-4">
            Quarterly cohorts · % of cohort active in subsequent quarters
          </p>
          <CohortRetention
            cohorts={cohorts?.cohorts ?? []}
            quarters={cohorts?.quarters ?? []}
          />
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
          USD-pegged token volumes (USDCf, FUSD, DUC)
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
