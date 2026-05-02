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
  ShieldAlert,
} from "lucide-react"
import KpiCard from "./KpiCard"
import HealthBar from "./HealthBar"
import VolumeChart from "./VolumeChart"
import NewWalletsChart from "./NewWalletsChart"
import CohortRetention from "./CohortRetention"
import LeaderboardTable, { type LeaderboardDisplayRow } from "./LeaderboardTable"
import LenderPerformanceTable from "./LenderPerformanceTable"
import PositionTransfersCard from "./PositionTransfersCard"
import FilterBar, { type LoanWindow } from "./FilterBar"
import ExploreSection from "./ExploreSection"
import type {
  AnalyticsSummaryResponse,
  AnalyticsTimeseriesRow,
  AnalyticsNewWalletsRow,
  AnalyticsCohortRow,
  AnalyticsLimboSummary,
} from "@/lib/analytics-types"

const ALL_COLLECTIONS: Array<{ key: string; label: string }> = [
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

interface LoansDashboardProps {
  // When set, scopes every fetch to a single collection (or comma-separated
  // list). The collection-toggle chip row is hidden in this mode since the
  // page is dedicated to that collection.
  collection?: string | string[] | null
  // Headline strings rendered by the FilterBar. Defaults are tuned for the
  // root /analytics/loans page — collection drill-down pages override.
  title?: string
  subtitle?: string
  // Hides the per-collection ExploreSection at the bottom (useful on
  // drill-down pages, which already have a "back to all loans" link).
  hideExploreSection?: boolean
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

function normalizeCollectionProp(prop?: string | string[] | null): string[] {
  if (!prop) return []
  if (Array.isArray(prop)) return prop.filter(Boolean)
  return prop
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

export default function LoansDashboard({
  collection,
  title,
  subtitle,
  hideExploreSection,
}: LoansDashboardProps = {}) {
  // When the page is locked to a single collection, the collection prop
  // pins the active set; user-toggles are still allowed but bounded by the
  // page's collection list (FilterBar is hidden in single-collection mode
  // to keep the UI honest).
  const pinnedCollections = useMemo(
    () => normalizeCollectionProp(collection),
    [collection]
  )
  const isPinned = pinnedCollections.length > 0

  const [window, setWindow] = useState<LoanWindow>("all")
  const [activeCollections, setActiveCollections] = useState<string[]>(
    pinnedCollections
  )
  const [lenderTab, setLenderTab] = useState<"volume" | "yield">("volume")

  // If the prop changes (e.g. via Next.js navigation between drill-downs),
  // reset the active set to match.
  useEffect(() => {
    setActiveCollections(pinnedCollections)
  }, [pinnedCollections])

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
    // The pinned-collection sync effect above keeps activeCollections in
    // step with pinnedCollections, so we can read it directly.
    const qs = buildQs(window, activeCollections)
    const collectionsQs = activeCollections.length > 0 ? `?collections=${activeCollections.join(",")}` : ""

    // Hardcode min_volume=100 on the leaderboard fetches to filter the dust
    // ranks ($0/$1 from canceled or test loans). Callers who want the dust
    // back can pass min_volume=0 directly to the API.
    const calls: Array<Promise<unknown>> = [
      fetch(`/api/analytics/loans/summary?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/limbo-summary${collectionsQs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/timeseries?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/new-wallets?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/cohorts${collectionsQs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/leaderboard?role=lender&min_volume=100&${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/loans/leaderboard?role=borrower&min_volume=100&${qs}`).then((r) => r.json()),
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

  // The summary RPC now returns `avg_apr` (annualized) and `avg_term_rate`
  // (rate-over-term, the value previously surfaced as "Avg interest rate").
  // Old payloads with `avg_interest_rate` are still tolerated.
  const aprNow =
    summary?.avg_apr != null
      ? summary.avg_apr
      : summary?.avg_term_rate != null
        ? summary.avg_term_rate
        : (summary?.avg_interest_rate ?? null)
  const aprPrev =
    prior?.avg_apr != null
      ? prior.avg_apr
      : prior?.avg_term_rate != null
        ? prior.avg_term_rate
        : (prior?.avg_interest_rate ?? null)
  const aprDelta = deltaPct(
    aprNow != null ? aprNow * 100 : null,
    aprPrev != null ? aprPrev * 100 : null
  )

  const defaultRate = summary?.default_rate_pct ?? null
  const priorDefaultRate = prior?.default_rate_pct ?? null
  const defaultRateDelta = deltaPct(defaultRate, priorDefaultRate)

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

  const aprPct = aprNow != null ? Math.round(aprNow * 100 * 10) / 10 : null
  const termRatePct =
    summary?.avg_term_rate != null
      ? Math.round(summary.avg_term_rate * 100 * 10) / 10
      : summary?.avg_interest_rate != null
        ? Math.round(summary.avg_interest_rate * 100 * 10) / 10
        : null
  const avgTermDays = summary?.avg_term_days ?? null

  // Sublabel for the APR card surfaces the raw term rate so readers can see
  // both numbers — the annualized comparison metric and the lender's actual
  // term quote.
  const aprSublabel = useMemo(() => {
    if (termRatePct == null) return undefined
    if (avgTermDays == null) return `${termRatePct.toFixed(1)}% over term`
    return `${termRatePct.toFixed(1)}% over ${Math.round(avgTermDays)}d term`
  }, [termRatePct, avgTermDays])

  // "data freshness" caption for the Limbo card: hours since last terminal
  // event. The pre-window cohort is bounded — once the last pre-window
  // loan is closed, this clock just keeps ticking.
  const limboFreshness = limbo?.data_freshness_hours ?? null
  const limboFreshnessLabel = useMemo(() => {
    if (limboFreshness == null) return null
    const hrs = limboFreshness
    if (hrs < 24) return `${hrs.toFixed(1)} hours since last terminal event`
    return `${(hrs / 24).toFixed(1)} days since last terminal event`
  }, [limboFreshness])

  const totalPreWindow = limbo?.total_pre_window_loans ?? limbo?.total_loans ?? null
  const graceSettlements = limbo?.grace_period_settlements ?? null
  const graceRepayments = limbo?.grace_period_repayments ?? null
  const preReopenRepayments = limbo?.pre_reopen_terminations ?? null

  return (
    <div className="space-y-8">
      <FilterBar
        title={title ?? "Flowty Loan Analytics"}
        subtitle={
          subtitle ??
          "Live capital flow on Flowty NFT-collateralized loans. Data refreshes every 10 minutes."
        }
        // Hide the collection chips on a per-collection drill-down — the
        // page already represents that scope; toggling away from it would
        // be confusing.
        collections={isPinned ? [] : ALL_COLLECTIONS}
        activeCollections={activeCollections}
        onCollectionsChange={setActiveCollections}
        window={window}
        onWindowChange={setWindow}
      />

      <section className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-7">
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
          label="Avg APR"
          value={aprPct != null ? `${aprPct.toFixed(1)}%` : "—"}
          sublabel={aprSublabel}
          delta={aprDelta}
          icon={Percent}
          accent="rose"
        />
        <KpiCard
          label="Default rate"
          value={defaultRate != null ? `${defaultRate.toFixed(2)}%` : "—"}
          sublabel="settled / (repaid + settled)"
          delta={defaultRateDelta}
          icon={ShieldAlert}
          accent="rose"
        />
      </section>

      {/* Pre-window loan closures — loans whose origination predates our
          scan window (Dec 29 2025). We see only their terminal events.
          Mixing them with originated-in-window KPIs above was the main
          source of inflated numbers, so they get their own section.
          The naming was previously "Limbo recovery cohort" which oversold
          what's actually a mostly-normal-repayment story plus 348 closures
          during Flowty's official Limbo grace period (Jan 30 – Feb 13). */}
      <section className="rounded-xl border border-emerald-900/40 bg-gradient-to-br from-emerald-950/40 to-slate-950/40 p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div className="flex items-start gap-3 max-w-2xl">
            <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20 flex-shrink-0">
              <ShieldCheck size={16} className="text-emerald-400" />
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-emerald-400 font-semibold mb-1">
                Pre-window loan closures
              </div>
              <h2 className="text-lg font-semibold text-slate-100">
                {totalPreWindow != null
                  ? `${formatNumber(totalPreWindow)} pre-window loan closures`
                  : "—"}
              </h2>
              <p className="text-sm text-slate-400 mt-1 leading-relaxed">
                Loans whose origination predates our scan window (Dec 29 2025). Includes{" "}
                <span className="text-slate-200">
                  {graceSettlements != null && graceRepayments != null
                    ? formatNumber(graceSettlements + graceRepayments)
                    : "—"}
                </span>{" "}
                closures during Flowty&apos;s official Limbo grace period (Jan 30 – Feb 13 2026).
              </p>
              {limboFreshnessLabel ? (
                <p className="text-[11px] text-slate-500 mt-2 italic">
                  Data freshness: {limboFreshnessLabel}.
                </p>
              ) : null}
            </div>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 lg:flex-shrink-0 lg:max-w-xl">
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Grace settlements
              </div>
              <div className="text-xl font-semibold text-rose-300 tabular-nums">
                {graceSettlements != null ? formatNumber(graceSettlements) : "—"}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">platform recovery</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Grace repayments
              </div>
              <div className="text-xl font-semibold text-emerald-300 tabular-nums">
                {graceRepayments != null ? formatNumber(graceRepayments) : "—"}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">borrower-driven</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Pre-reopen repayments
              </div>
              <div className="text-xl font-semibold text-slate-100 tabular-nums">
                {preReopenRepayments != null ? formatNumber(preReopenRepayments) : "—"}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">before Jan 30</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
                Repayment rate
              </div>
              <div className="text-xl font-semibold text-emerald-400 tabular-nums">
                {limbo ? formatPct(limbo.repayment_rate_pct) : "—"}
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5">repaid / total</div>
            </div>
          </div>
        </div>
      </section>

      <PositionTransfersCard />

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
              {isPinned ? `${pinnedCollections.join(", ")} · ` : "Stacked by collection · "}
              {windowLabel}
            </p>
          </div>
        </div>
        <VolumeChart
          rows={timeseries?.rows ?? []}
          activeCollections={activeCollections}
          weekly={timeseries?.bucket === "week"}
          singleCollection={isPinned}
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
          <h2 className="text-lg font-semibold text-slate-100 mb-1">Cohort activity</h2>
          <p className="text-xs text-slate-500 mb-4">
            Monthly cohorts · % of cohort active in subsequent months (not strict retention — wallets can return after a gap)
          </p>
          <CohortRetention rows={cohorts?.rows ?? []} />
        </div>
      </section>

      <section className="grid gap-6 lg:grid-cols-2">
        <div className="flex flex-col gap-3">
          <div className="inline-flex self-start rounded-lg border border-slate-800 bg-slate-900/60 p-1 text-xs">
            <button
              type="button"
              onClick={() => setLenderTab("volume")}
              className={
                "px-3 py-1.5 rounded-md transition-colors " +
                (lenderTab === "volume"
                  ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-semibold"
                  : "text-slate-400 hover:text-slate-200")
              }
            >
              Volume
            </button>
            <button
              type="button"
              onClick={() => setLenderTab("yield")}
              className={
                "px-3 py-1.5 rounded-md transition-colors " +
                (lenderTab === "yield"
                  ? "bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 font-semibold"
                  : "text-slate-400 hover:text-slate-200")
              }
            >
              Realized yield
            </button>
          </div>
          {lenderTab === "volume" ? (
            <LeaderboardTable
              rows={topLenders?.rows ?? []}
              role="lender"
              window={windowLabel}
            />
          ) : (
            <LenderPerformanceTable collections={activeCollections} />
          )}
        </div>
        <LeaderboardTable
          rows={topBorrowers?.rows ?? []}
          role="borrower"
          window={windowLabel}
        />
      </section>

      {hideExploreSection ? null : (
        <ExploreSection
          title="Per-collection drill-downs"
          items={[
            {
              label: "Top Shot Loans",
              description: "Loan book against NBA Top Shot moments.",
              href: "/analytics/loans/topshot",
              enabled: true,
            },
            {
              label: "NFL All Day Loans",
              description: "Loan book against NFL All Day moments.",
              href: "/analytics/loans/allday",
              enabled: true,
            },
            {
              label: "UFC Strike Loans",
              description: "Loan book against UFC Strike collectibles.",
              href: "/analytics/loans/ufc",
              enabled: true,
            },
            {
              label: "Wallet directory",
              description: "Browse every active lender and borrower.",
              href: "/analytics/wallets",
              enabled: true,
            },
          ]}
        />
      )}

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
