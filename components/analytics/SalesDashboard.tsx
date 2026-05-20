"use client"

import { useEffect, useMemo, useState } from "react"
import {
  BarChart3,
  DollarSign,
  Users,
  Activity,
  CircleDollarSign,
  TimerReset,
  Sigma,
  Tag,
  Info,
} from "lucide-react"
import KpiCard from "./KpiCard"
import VolumeChart from "./VolumeChart"
import LeaderboardTable, { type LeaderboardDisplayRow } from "./LeaderboardTable"
import FilterBar, { type LoanWindow } from "./FilterBar"
import ExploreSection from "./ExploreSection"
import MarketplaceMix from "./MarketplaceMix"
import BiggestSales from "./BiggestSales"
import type {
  SalesSummaryResponse,
  SalesTimeseriesRow,
  SalesTopMoveRow,
  AnalyticsTimeseriesRow,
} from "@/lib/analytics-types"

const ALL_COLLECTIONS: Array<{ key: string; label: string }> = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "Golazos" },
  { key: "ufc", label: "UFC Strike" },
  { key: "pinnacle", label: "Pinnacle" },
]

interface TimeseriesResponse {
  rows: SalesTimeseriesRow[]
  bucket: "auto" | "day" | "week"
}

interface LeaderboardResponse {
  role: string
  rows: LeaderboardDisplayRow[]
}

interface TopMovesResponse {
  rows: SalesTopMoveRow[]
}

interface SalesDashboardProps {
  collection?: string | string[] | null
  title?: string
  subtitle?: string
  hideExploreSection?: boolean
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function formatPrice(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—"
  if (n >= 10_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

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

// VolumeChart was built for the loans payload (principal_usd / loan_count).
// The shape is identical otherwise, so we just re-key the sales rows.
function reshapeForVolumeChart(rows: SalesTimeseriesRow[]): AnalyticsTimeseriesRow[] {
  return rows.map((r) => ({
    bucket: r.bucket,
    collection: r.collection,
    loan_count: r.sale_count,
    principal_usd: Number(r.volume_usd) || 0,
    repayment_usd: 0,
  }))
}

export default function SalesDashboard({
  collection,
  title,
  subtitle,
  hideExploreSection,
}: SalesDashboardProps = {}) {
  const pinnedCollections = useMemo(
    () => normalizeCollectionProp(collection),
    [collection]
  )
  const isPinned = pinnedCollections.length > 0

  const [window, setWindow] = useState<LoanWindow>("l30")
  const [activeCollections, setActiveCollections] = useState<string[]>(
    pinnedCollections
  )

  useEffect(() => {
    setActiveCollections(pinnedCollections)
  }, [pinnedCollections])

  const [summary, setSummary] = useState<SalesSummaryResponse | null>(null)
  const [timeseries, setTimeseries] = useState<TimeseriesResponse | null>(null)
  const [topBuyers, setTopBuyers] = useState<LeaderboardResponse | null>(null)
  const [topSellers, setTopSellers] = useState<LeaderboardResponse | null>(null)
  const [topMoves, setTopMoves] = useState<TopMovesResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = buildQs(window, activeCollections)

    const calls: Array<Promise<unknown>> = [
      fetch(`/api/analytics/sales/summary?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/sales/timeseries?${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/sales/leaderboard?role=buyer&min_volume=100&${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/sales/leaderboard?role=seller&min_volume=100&${qs}`).then((r) => r.json()),
      fetch(`/api/analytics/sales/top-moves?limit=20&${qs}`).then((r) => r.json()),
    ]

    Promise.all(calls)
      .then(([s, ts, tb, tse, tm]) => {
        if (cancelled) return
        setSummary(s as SalesSummaryResponse | null)
        setTimeseries(ts as TimeseriesResponse)
        setTopBuyers(tb as LeaderboardResponse)
        setTopSellers(tse as LeaderboardResponse)
        setTopMoves(tm as TopMovesResponse)
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
  const volumeDelta = deltaPct(summary?.total_volume_usd, prior?.total_volume_usd)
  const salesDelta = deltaPct(summary?.total_sales, prior?.total_sales)
  const buyersDelta = deltaPct(summary?.unique_buyers, prior?.unique_buyers)
  const sellersDelta = deltaPct(summary?.unique_sellers, prior?.unique_sellers)
  const avgPriceDelta = deltaPct(summary?.avg_price_usd, prior?.avg_price_usd)
  const medianDelta = deltaPct(summary?.median_price_usd, prior?.median_price_usd)

  const reshapedTimeseries = useMemo(
    () => (timeseries ? reshapeForVolumeChart(timeseries.rows) : []),
    [timeseries]
  )

  return (
    <div className="space-y-8">
      <FilterBar
        title={title ?? "Sales Analytics"}
        subtitle={
          subtitle ??
          "Live secondary-market activity across NBA Top Shot, NFL All Day, LaLiga Golazos, UFC Strike, and Disney Pinnacle. Data refreshes every 10 minutes."
        }
        collections={isPinned ? [] : ALL_COLLECTIONS}
        activeCollections={activeCollections}
        onCollectionsChange={setActiveCollections}
        window={window}
        onWindowChange={setWindow}
      />

      <section className="grid gap-3 grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Total volume"
          value={summary ? formatUsd(summary.total_volume_usd) : "—"}
          sublabel={summary ? `${formatNumber(summary.total_sales)} sales` : undefined}
          delta={volumeDelta}
          icon={DollarSign}
          accent="emerald"
        />
        <KpiCard
          label="Sale count"
          value={summary ? formatNumber(summary.total_sales) : "—"}
          sublabel={windowLabel}
          delta={salesDelta}
          icon={BarChart3}
          accent="sky"
        />
        <KpiCard
          label="Unique buyers"
          value={summary ? formatNumber(summary.unique_buyers) : "—"}
          sublabel="On-chain only"
          delta={buyersDelta}
          icon={Users}
          accent="emerald"
        />
        <KpiCard
          label="Unique sellers"
          value={summary ? formatNumber(summary.unique_sellers) : "—"}
          sublabel="On-chain only"
          delta={sellersDelta}
          icon={Users}
          accent="amber"
        />
        <KpiCard
          label="Average price"
          value={summary ? formatPrice(summary.avg_price_usd) : "—"}
          sublabel={summary?.p90_price_usd != null ? `P90 ${formatPrice(summary.p90_price_usd)}` : undefined}
          delta={avgPriceDelta}
          icon={Sigma}
          accent="sky"
        />
        <KpiCard
          label="Median price"
          value={summary ? formatPrice(summary.median_price_usd) : "—"}
          sublabel={summary?.max_price_usd != null ? `Max ${formatPrice(summary.max_price_usd)}` : undefined}
          delta={medianDelta}
          icon={Tag}
          accent="rose"
        />
      </section>

      <div className="rounded-lg border border-amber-900/40 bg-amber-950/20 p-3 flex items-start gap-2.5">
        <Info size={16} className="text-amber-400 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-zinc-300 leading-relaxed">
          Buyer and seller counts reflect on-chain marketplace activity only. NBA Top Shot’s centralized
          marketplace (~94% of total volume) doesn’t expose participant wallets, so leaderboard data is
          concentrated on Flowty and direct on-chain Pinnacle sales. Total volume figures include all
          marketplaces.{" "}
          <a
            href="/analytics/methodology/sales"
            className="text-amber-300 hover:text-amber-200 underline underline-offset-2"
          >
            Methodology
          </a>
        </p>
      </div>

      <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100">Volume over time</h2>
            <p className="text-xs text-zinc-500">
              {isPinned ? `${pinnedCollections.join(", ")} · ` : "Stacked by collection · "}
              {windowLabel}
            </p>
          </div>
        </div>
        <VolumeChart
          rows={reshapedTimeseries}
          activeCollections={activeCollections}
          weekly={timeseries?.bucket === "week"}
          singleCollection={isPinned}
        />
      </section>

      <MarketplaceMix data={summary?.marketplace_breakdown} />

      <section className="grid gap-6 lg:grid-cols-2">
        <LeaderboardTable
          rows={topBuyers?.rows ?? []}
          role="buyer"
          window={windowLabel}
        />
        <LeaderboardTable
          rows={topSellers?.rows ?? []}
          role="seller"
          window={windowLabel}
        />
      </section>

      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-zinc-100">Biggest sales</h2>
          <p className="text-xs text-zinc-500">
            Largest individual sales in {windowLabel.toLowerCase()} · USD-pegged
          </p>
        </div>
        <BiggestSales rows={topMoves?.rows ?? []} />
      </section>

      {hideExploreSection ? null : (
        <ExploreSection
          title="Per-collection drill-downs"
          items={[
            {
              label: "Top Shot Sales",
              description: "Secondary-market volume across NBA Top Shot.",
              href: "/analytics/sales/topshot",
              enabled: true,
            },
            {
              label: "NFL All Day Sales",
              description: "Sales across NFL All Day moments.",
              href: "/analytics/sales/allday",
              enabled: true,
            },
            {
              label: "Golazos Sales",
              description: "Sales across LaLiga Golazos.",
              href: "/analytics/sales/golazos",
              enabled: true,
            },
            {
              label: "Pinnacle Sales",
              description: "Direct on-chain Pinnacle sales — full wallet detail.",
              href: "/analytics/sales/pinnacle",
              enabled: true,
            },
          ]}
        />
      )}

      <footer className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 pt-2 border-t border-zinc-800">
        <span className="inline-flex items-center gap-1.5">
          <Activity size={12} className="text-emerald-500" />
          {loading ? "Refreshing…" : refreshedAt ? `Refreshed ${new Date(refreshedAt).toLocaleTimeString()}` : "Idle"}
        </span>
        <span className="text-zinc-700">·</span>
        <a
          href="/analytics/methodology/sales"
          className="hover:text-emerald-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
        </a>
        <span className="text-zinc-700">·</span>
        <span className="inline-flex items-center gap-1.5">
          <CircleDollarSign size={12} />
          USD-pegged token volumes
        </span>
        <span className="text-zinc-700">·</span>
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          10-min refresh
        </span>
      </footer>
    </div>
  )
}
