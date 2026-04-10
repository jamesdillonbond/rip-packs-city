"use client"

import { useParams } from "next/navigation"
import { useState, useEffect } from "react"
import {
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts"

// ── Constants ────────────────────────────────────────────────────────────────

const PERIODS = [
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "90d", label: "90D" },
  { key: "ytd", label: "YTD" },
  { key: "all", label: "ALL" },
] as const

const MP_COLORS: Record<string, string> = {
  topshot: "#E03A2F",
  flowty: "#4F94D4",
  primary: "#22C55E",
  other: "#A855F7",
  unknown: "#A855F7",
}

function mpColor(mp: string): string {
  return MP_COLORS[mp] || "#A855F7"
}

function formatVolume(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`
  return `$${v.toFixed(0)}`
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US")
}

// ── Types ────────────────────────────────────────────────────────────────────

interface DailyRow {
  date: string
  marketplace: string
  saleCount: number
  volume: number
}

interface ApiResponse {
  period: string
  startDate: string
  endDate: string
  totals: { totalSales: number; totalVolume: number }
  daily: DailyRow[]
}

// ── Page ─────────────────────────────────────────────────────────────────────

export default function AnalyticsPage() {
  const params = useParams()
  const collection = params?.collection as string
  const [period, setPeriod] = useState("30d")
  const [data, setData] = useState<ApiResponse | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    fetch(`/api/market-analytics?collection=${collection}&period=${period}`)
      .then((r) => r.json())
      .then((json) => {
        setData(json.error ? null : json)
        setLoading(false)
      })
      .catch(() => {
        setData(null)
        setLoading(false)
      })
  }, [collection, period])

  // Derive chart data
  const marketplaces = data
    ? [...new Set(data.daily.map((d) => d.marketplace))]
    : []

  // Pivot daily data: { date, topshot_volume, flowty_volume, ... }
  const volumeByDate = new Map<string, Record<string, number | string>>()
  const salesByDate = new Map<string, Record<string, number | string>>()

  if (data) {
    for (const row of data.daily) {
      // Volume
      const vEntry: Record<string, number | string> = volumeByDate.get(row.date) || { date: row.date }
      vEntry[row.marketplace] = (Number(vEntry[row.marketplace]) || 0) + row.volume
      volumeByDate.set(row.date, vEntry)

      // Sales
      const sEntry: Record<string, number | string> = salesByDate.get(row.date) || { date: row.date }
      sEntry[row.marketplace] = (Number(sEntry[row.marketplace]) || 0) + row.saleCount
      salesByDate.set(row.date, sEntry)
    }
  }

  const volumeChartData = Array.from(volumeByDate.values())
  const salesChartData = Array.from(salesByDate.values())

  // Pie data: volume share by marketplace
  const pieData = marketplaces.map((mp) => {
    const vol = data!?.daily
      .filter((d) => d.marketplace === mp)
      .reduce((sum, d) => sum + d.volume, 0)
    return { name: mp, value: Math.round((vol || 0) * 100) / 100 }
  }).filter((d) => d.value > 0)

  const avgSale =
    data && data.totals.totalSales > 0
      ? data.totals.totalVolume / data.totals.totalSales
      : 0

  // Collection accent color for active period button
  const accentMap: Record<string, string> = {
    "nba-top-shot": "#E03A2F",
    "nfl-all-day": "#4F94D4",
    "disney-pinnacle": "#A855F7",
    "laliga-golazos": "#22C55E",
    "ufc": "#EF4444",
  }
  const accent = accentMap[collection] || "#E03A2F"

  return (
    <div className="min-h-screen bg-zinc-950 text-white px-4 py-6 max-w-6xl mx-auto">
      {/* Period toggle */}
      <div className="flex gap-2 mb-6">
        {PERIODS.map((p) => (
          <button
            key={p.key}
            onClick={() => setPeriod(p.key)}
            className="px-4 py-2 rounded text-sm font-semibold transition-colors"
            style={
              period === p.key
                ? { backgroundColor: accent, color: "#fff" }
                : { backgroundColor: "#27272a", color: "#a1a1aa" }
            }
          >
            {p.label}
          </button>
        ))}
      </div>

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-4">
          <div className="flex gap-4">
            {[1, 2, 3].map((i) => (
              <div key={i} className="flex-1 h-24 bg-zinc-900 rounded animate-pulse" />
            ))}
          </div>
          <div className="h-64 bg-zinc-900 rounded animate-pulse" />
          <div className="h-64 bg-zinc-900 rounded animate-pulse" />
        </div>
      )}

      {/* No data */}
      {!loading && !data && (
        <div className="text-center text-zinc-500 py-20">
          No sales data available for this collection and period.
        </div>
      )}

      {/* Dashboard */}
      {!loading && data && (
        <>
          {/* KPI cards */}
          <div className="flex gap-4 mb-8">
            <div className="flex-1 bg-zinc-900 rounded-lg p-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1" style={{ fontFamily: "var(--font-barlow, 'Barlow Condensed', sans-serif)" }}>
                Total Volume
              </div>
              <div className="text-2xl font-bold" style={{ fontFamily: "var(--font-share-tech, 'Share Tech Mono', monospace)" }}>
                {formatVolume(data.totals.totalVolume)}
              </div>
            </div>
            <div className="flex-1 bg-zinc-900 rounded-lg p-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1" style={{ fontFamily: "var(--font-barlow, 'Barlow Condensed', sans-serif)" }}>
                Total Sales
              </div>
              <div className="text-2xl font-bold" style={{ fontFamily: "var(--font-share-tech, 'Share Tech Mono', monospace)" }}>
                {formatNumber(data.totals.totalSales)}
              </div>
            </div>
            <div className="flex-1 bg-zinc-900 rounded-lg p-4">
              <div className="text-xs text-zinc-500 uppercase tracking-wider mb-1" style={{ fontFamily: "var(--font-barlow, 'Barlow Condensed', sans-serif)" }}>
                Avg Sale Price
              </div>
              <div className="text-2xl font-bold" style={{ fontFamily: "var(--font-share-tech, 'Share Tech Mono', monospace)" }}>
                ${avgSale.toFixed(2)}
              </div>
            </div>
          </div>

          {/* Daily Volume chart */}
          <div className="mb-8">
            <h2
              className="text-lg uppercase tracking-wider mb-3"
              style={{ fontFamily: "var(--font-barlow, 'Barlow Condensed', sans-serif)" }}
            >
              Daily Volume
            </h2>
            <div className="bg-zinc-900 rounded-lg p-4">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={volumeChartData}>
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#71717a", fontSize: 11 }}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis
                    tick={{ fill: "#71717a", fontSize: 11 }}
                    tickFormatter={(v: number) => formatVolume(v)}
                  />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                    labelStyle={{ color: "#a1a1aa" }}
                  />
                  <Legend />
                  {marketplaces.map((mp) => (
                    <Line
                      key={mp}
                      type="monotone"
                      dataKey={mp}
                      stroke={mpColor(mp)}
                      strokeWidth={2}
                      dot={false}
                      name={mp}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Daily Sales chart */}
          <div className="mb-8">
            <h2
              className="text-lg uppercase tracking-wider mb-3"
              style={{ fontFamily: "var(--font-barlow, 'Barlow Condensed', sans-serif)" }}
            >
              Daily Sales
            </h2>
            <div className="bg-zinc-900 rounded-lg p-4">
              <ResponsiveContainer width="100%" height={280}>
                <LineChart data={salesChartData}>
                  <XAxis
                    dataKey="date"
                    tick={{ fill: "#71717a", fontSize: 11 }}
                    tickFormatter={(v: string) => v.slice(5)}
                  />
                  <YAxis tick={{ fill: "#71717a", fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                    labelStyle={{ color: "#a1a1aa" }}
                  />
                  <Legend />
                  {marketplaces.map((mp) => (
                    <Line
                      key={mp}
                      type="monotone"
                      dataKey={mp}
                      stroke={mpColor(mp)}
                      strokeWidth={2}
                      dot={false}
                      name={mp}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Market Share pie */}
          <div className="mb-8">
            <h2
              className="text-lg uppercase tracking-wider mb-3"
              style={{ fontFamily: "var(--font-barlow, 'Barlow Condensed', sans-serif)" }}
            >
              Market Share
            </h2>
            <div className="bg-zinc-900 rounded-lg p-4 flex justify-center">
              <ResponsiveContainer width="100%" height={300}>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    outerRadius={110}
                    label={(props: any) =>
                      `${props.name ?? ""} ${((props.percent ?? 0) * 100).toFixed(0)}%`
                    }
                  >
                    {pieData.map((entry) => (
                      <Cell key={entry.name} fill={mpColor(entry.name)} />
                    ))}
                  </Pie>
                  <Tooltip
                    contentStyle={{ backgroundColor: "#18181b", border: "1px solid #3f3f46", borderRadius: 8 }}
                    formatter={(value: any) => formatVolume(Number(value) || 0)}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Footer note */}
          <p className="text-xs text-zinc-600 text-center">
            Data sourced from on-chain sales indexed by RPC. Updates every 20 minutes.
          </p>
        </>
      )}
    </div>
  )
}
