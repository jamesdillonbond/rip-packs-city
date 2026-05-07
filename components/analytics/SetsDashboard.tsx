"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowUpRight,
  BarChart3,
  Info,
  Layers,
  TimerReset,
} from "lucide-react"
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"
import type {
  SetsDirectoryRow,
  SetsDirectorySort,
  SetsSeriesOverviewRow,
  SetsSummaryResponse,
} from "@/lib/analytics-types"
import { isUnmappedSeriesLabel, seriesLabel } from "@/lib/analytics/series-labels"

const SET_COLLECTIONS = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "NFL All Day" },
  { key: "golazos", label: "LaLiga Golazos" },
  { key: "pinnacle", label: "Disney Pinnacle" },
  { key: "ufc", label: "UFC Strike" },
] as const

const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC",
}

const COLLECTION_COLOR: Record<string, string> = {
  topshot: "#a78bfa",
  allday: "#34d399",
  golazos: "#22d3ee",
  pinnacle: "#f472b6",
  ufc: "#f97316",
}

const TIER_ORDER = ["common", "fandom", "rare", "legendary", "ultimate"] as const
const TIER_LABEL: Record<(typeof TIER_ORDER)[number], string> = {
  common: "Common",
  fandom: "Fandom",
  rare: "Rare",
  legendary: "Legendary",
  ultimate: "Ultimate",
}
const TIER_COLOR: Record<(typeof TIER_ORDER)[number], string> = {
  common: "#94A3B8",
  fandom: "#60A5FA",
  rare: "#22D3EE",
  legendary: "#F59E0B",
  ultimate: "#F43F5E",
}

const SORT_OPTIONS: Array<{ value: SetsDirectorySort; label: string }> = [
  { value: "value_desc", label: "Value" },
  { value: "newest", label: "Newest" },
  { value: "name_asc", label: "Name" },
  { value: "completion_desc", label: "Completion" },
]

const COVERAGE_OPTIONS = [0, 50, 75, 100]
const LIMIT_OPTIONS = [50, 100, 200]

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  if (n >= 1) return `$${n.toFixed(2)}`
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function formatPct(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}%`
}

interface DirectoryResponse {
  rows: SetsDirectoryRow[]
  sort: SetsDirectorySort
  min_coverage: number
  limit: number
}

interface SeriesResponse {
  rows: SetsSeriesOverviewRow[]
}

function CoverageBar({ pct }: { pct: number }) {
  const clamped = Math.max(0, Math.min(100, pct))
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-800">
        <div
          className="h-full bg-violet-500/70"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-slate-400 w-9 text-right">
        {clamped.toFixed(0)}%
      </span>
    </div>
  )
}

function CollectionChip({ collection }: { collection: string }) {
  const label = COLLECTION_LABEL[collection.toLowerCase()] ?? collection
  const color = COLLECTION_COLOR[collection.toLowerCase()] ?? "#94a3b8"
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-slate-300"
      style={{ borderColor: `${color}55` }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ backgroundColor: color }}
      />
      {label}
    </span>
  )
}

function CollectionSummaryCard({
  collectionKey,
  label,
  setCount,
  editionCount,
  tierBreakdown,
}: {
  collectionKey: string
  label: string
  setCount: number
  editionCount: number
  tierBreakdown: Record<string, number>
}) {
  const total = TIER_ORDER.reduce((s, t) => s + (tierBreakdown[t] || 0), 0)
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-slate-100">{label}</h3>
          <p className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mt-0.5">
            {COLLECTION_LABEL[collectionKey] ?? collectionKey}
          </p>
        </div>
        <Layers
          size={16}
          style={{ color: COLLECTION_COLOR[collectionKey] ?? "#94a3b8" }}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
            Sets
          </div>
          <div className="text-3xl font-bold text-slate-50 tabular-nums leading-none">
            {formatNumber(setCount)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-1">
            Editions
          </div>
          <div className="text-3xl font-bold text-slate-50 tabular-nums leading-none">
            {formatNumber(editionCount)}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
          Tier mix
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded border border-slate-800">
          {TIER_ORDER.map((t) => {
            const count = tierBreakdown[t] || 0
            const pct = total > 0 ? (count / total) * 100 : 0
            if (pct <= 0) return null
            return (
              <div
                key={t}
                style={{ width: `${pct}%`, backgroundColor: TIER_COLOR[t] }}
                title={`${TIER_LABEL[t]} · ${formatNumber(count)} (${pct.toFixed(1)}%)`}
              />
            )
          })}
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          {TIER_ORDER.map((t) => {
            const count = tierBreakdown[t] || 0
            if (count <= 0) return null
            return (
              <div
                key={t}
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold text-slate-400"
              >
                <span
                  className="inline-block h-1.5 w-1.5 rounded-sm"
                  style={{ backgroundColor: TIER_COLOR[t] }}
                />
                {TIER_LABEL[t]} {formatNumber(count)}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

function SeriesOverview({ rows }: { rows: SetsSeriesOverviewRow[] }) {
  // Group rows by series_label across collections, render a stacked bar
  // chart per label segmented by collection. Values are total robust FMV.
  const { chartData, labels } = useMemo(() => {
    const labelMap = new Map<string, Record<string, number>>()
    for (const r of rows) {
      if (!r.series_label) continue
      const existing = labelMap.get(r.series_label) ?? {}
      existing[r.collection] =
        (existing[r.collection] ?? 0) + (r.total_series_fmv_robust || 0)
      labelMap.set(r.series_label, existing)
    }

    // Order: real series first (in canonical order), Misc / Unmapped last.
    const real = Array.from(labelMap.keys()).filter(
      (l) => !isUnmappedSeriesLabel(l)
    )
    real.sort((a, b) => {
      // Heuristic: pull "Series N" / "Series 2024-25" / "Summer 2021" into
      // a sane chronological order using a hand-rolled rank.
      const RANK: Record<string, number> = {
        "Series 1": 1,
        "Series 2": 2,
        "Summer 2021": 3,
        "Series 3": 4,
        "Series 4": 5,
        "Series 2023-24": 6,
        "Series 2024-25": 7,
        "Series 2025-26": 8,
      }
      const ra = RANK[a] ?? 99
      const rb = RANK[b] ?? 99
      if (ra !== rb) return ra - rb
      return a.localeCompare(b)
    })
    const ordered = [...real]
    for (const l of labelMap.keys()) {
      if (isUnmappedSeriesLabel(l)) ordered.push(l)
    }

    const data = ordered.map((label) => {
      const entry: Record<string, number | string> = { series_label: label }
      const buckets = labelMap.get(label) ?? {}
      for (const c of Object.keys(buckets)) {
        entry[c] = buckets[c]
      }
      return entry
    })

    return { chartData: data, labels: ordered }
  }, [rows])

  const collectionsPresent = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) set.add(r.collection)
    return Array.from(set)
  }, [rows])

  if (chartData.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
        No series data available.
      </div>
    )
  }

  // Aggregate-per-label rollup for the table below the chart.
  const tableRows = useMemo(() => {
    const map = new Map<
      string,
      {
        series_label: string
        set_count: number
        edition_count: number
        edition_count_with_fmv: number
        total_robust: number
        median_total: number
        median_count: number
      }
    >()
    for (const r of rows) {
      const existing = map.get(r.series_label) ?? {
        series_label: r.series_label,
        set_count: 0,
        edition_count: 0,
        edition_count_with_fmv: 0,
        total_robust: 0,
        median_total: 0,
        median_count: 0,
      }
      existing.set_count += r.set_count || 0
      existing.edition_count += r.edition_count || 0
      existing.edition_count_with_fmv += r.edition_count_with_fmv || 0
      existing.total_robust += r.total_series_fmv_robust || 0
      if (r.median_edition_fmv != null && Number.isFinite(r.median_edition_fmv)) {
        existing.median_total += r.median_edition_fmv
        existing.median_count += 1
      }
      map.set(r.series_label, existing)
    }
    return labels
      .map((l) => map.get(l))
      .filter(Boolean) as Array<{
      series_label: string
      set_count: number
      edition_count: number
      edition_count_with_fmv: number
      total_robust: number
      median_total: number
      median_count: number
    }>
  }, [rows, labels])

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 24, left: 0 }}
            >
              <CartesianGrid strokeDasharray="2 4" stroke="#1f2937" />
              <XAxis
                dataKey="series_label"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                interval={0}
                angle={-15}
                textAnchor="end"
                height={48}
                stroke="#334155"
              />
              <YAxis
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                stroke="#334155"
                tickFormatter={(v) => formatUsd(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#0f172a",
                  border: "1px solid #1e293b",
                  borderRadius: "8px",
                  fontSize: "12px",
                }}
                formatter={(value, name) => [
                  formatUsd(typeof value === "number" ? value : Number(value)),
                  COLLECTION_LABEL[String(name)] ?? String(name),
                ]}
              />
              <Legend
                formatter={(v) => COLLECTION_LABEL[v] ?? v}
                wrapperStyle={{ fontSize: "11px" }}
              />
              {collectionsPresent.map((c) => (
                <Bar
                  key={c}
                  dataKey={c}
                  stackId="a"
                  fill={COLLECTION_COLOR[c] ?? "#94a3b8"}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-slate-500 font-semibold border-b border-slate-800 bg-slate-900/60">
                <th className="py-2.5 px-4">Series</th>
                <th className="py-2.5 px-3 text-right">Sets</th>
                <th className="py-2.5 px-3 text-right">Editions</th>
                <th className="py-2.5 px-3 text-right">Coverage</th>
                <th className="py-2.5 px-3 text-right">Median FMV</th>
                <th className="py-2.5 px-3 text-right">Total robust FMV</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((r) => {
                const coverage =
                  r.edition_count > 0
                    ? (r.edition_count_with_fmv / r.edition_count) * 100
                    : 0
                const medAvg =
                  r.median_count > 0 ? r.median_total / r.median_count : null
                const unmapped = isUnmappedSeriesLabel(r.series_label)
                return (
                  <tr
                    key={r.series_label}
                    className="border-b border-slate-800/60 last:border-b-0 hover:bg-slate-900/30 transition-colors"
                  >
                    <td className="py-2.5 px-4 text-slate-200">
                      <div className="inline-flex items-center gap-1.5">
                        {r.series_label}
                        {unmapped ? (
                          <span
                            title="Anomalous series tagging — most editions in this bucket lack a real on-chain series tag (typically UUID-imported rows). They surface here for completeness but won't drive headline numbers."
                            className="text-amber-400"
                          >
                            <Info size={11} />
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                      {formatNumber(r.set_count)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                      {formatNumber(r.edition_count)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                      {formatPct(coverage, 0)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-300 tabular-nums">
                      {formatUsd(medAvg)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-slate-100 font-semibold tabular-nums">
                      {formatUsd(r.total_robust)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

export default function SetsDashboard() {
  const [activeCollections, setActiveCollections] = useState<string[]>([])
  const [sort, setSort] = useState<SetsDirectorySort>("value_desc")
  const [minCoverage, setMinCoverage] = useState<number>(0)
  const [limit, setLimit] = useState<number>(50)

  const [summary, setSummary] = useState<SetsSummaryResponse | null>(null)
  const [seriesResp, setSeriesResp] = useState<SeriesResponse | null>(null)
  const [directory, setDirectory] = useState<DirectoryResponse | null>(null)

  const [summaryLoading, setSummaryLoading] = useState(true)
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [directoryLoading, setDirectoryLoading] = useState(true)

  const collectionsQs = useMemo(
    () => (activeCollections.length > 0 ? activeCollections.join(",") : ""),
    [activeCollections]
  )

  useEffect(() => {
    let cancelled = false
    setSummaryLoading(true)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)
    fetch(`/api/analytics/sets/summary?${qs.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setSummary(j as SetsSummaryResponse)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSummaryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionsQs])

  useEffect(() => {
    let cancelled = false
    setSeriesLoading(true)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)
    fetch(`/api/analytics/sets/series?${qs.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setSeriesResp(j as SeriesResponse)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSeriesLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionsQs])

  useEffect(() => {
    let cancelled = false
    setDirectoryLoading(true)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)
    qs.set("sort", sort)
    qs.set("min_coverage", String(minCoverage))
    qs.set("limit", String(limit))
    fetch(`/api/analytics/sets/directory?${qs.toString()}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return
        setDirectory(j as DirectoryResponse)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setDirectoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionsQs, sort, minCoverage, limit])

  function toggleCollection(key: string) {
    setActiveCollections((curr) =>
      curr.includes(key) ? curr.filter((c) => c !== key) : [...curr, key]
    )
  }

  const summaryCollections = (summary?.collections ?? {}) as Record<
    string,
    { set_count: number; edition_count: number; tier_breakdown: Record<string, number> }
  >

  return (
    <div className="space-y-10">
      {/* Header + filter chips */}
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-slate-50 tracking-tight">
            Sets — Catalog Across Flow NFT Collections
          </h1>
          <p className="text-sm text-slate-400 max-w-2xl">
            Set-level rollups across NBA Top Shot, NFL All Day, LaLiga Golazos,
            and UFC Strike. Pinnacle has a separate set structure and is
            excluded.
          </p>
        </div>

        <div className="mt-4 rounded-lg border border-slate-800 bg-slate-950/50 p-3 flex items-start gap-2">
          <Info size={14} className="text-violet-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-slate-400 leading-relaxed">
            Aggregate values use the <em>robust</em> total — a 20× median cap
            on per-edition FMV that excludes listing-reward farming asks.{" "}
            <Link
              href="/analytics/methodology/sets"
              className="text-violet-400 hover:text-violet-300 underline"
            >
              Methodology
            </Link>
            .
          </p>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setActiveCollections([])}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (activeCollections.length === 0
                ? "border-violet-500/40 bg-violet-500/10 text-violet-400"
                : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200")
            }
          >
            All collections
          </button>
          {SET_COLLECTIONS.map((c) => {
            const active = activeCollections.includes(c.key)
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCollection(c.key)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                  (active
                    ? "border-violet-500/40 bg-violet-500/10 text-violet-400"
                    : "border-slate-700 text-slate-400 hover:border-slate-600 hover:text-slate-200")
                }
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Catalog summary */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-100">Catalog summary</h2>
          <p className="text-xs text-slate-500">
            Set + edition counts per collection, with tier mix
          </p>
        </div>
        {summaryLoading && !summary ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
            Loading catalog summary…
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {SET_COLLECTIONS.map((c) => {
              const stats = summaryCollections[c.key]
              if (!stats) {
                return (
                  <div
                    key={c.key}
                    className="rounded-xl border border-slate-800 bg-slate-900/40 p-5 opacity-60"
                  >
                    <h3 className="text-base font-semibold text-slate-300">
                      {c.label}
                    </h3>
                    <p className="text-xs text-slate-500 mt-1">No data</p>
                  </div>
                )
              }
              return (
                <CollectionSummaryCard
                  key={c.key}
                  collectionKey={c.key}
                  label={c.label}
                  setCount={stats.set_count}
                  editionCount={stats.edition_count}
                  tierBreakdown={stats.tier_breakdown}
                />
              )
            })}
          </div>
        )}
      </section>

      {/* Series overview */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-slate-100">Series overview</h2>
          <p className="text-xs text-slate-500">
            How robust value distributes across series eras, segmented by
            collection
          </p>
        </div>
        {seriesLoading && !seriesResp ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
            Loading series overview…
          </div>
        ) : (
          <SeriesOverview rows={seriesResp?.rows ?? []} />
        )}
      </section>

      {/* Sets directory */}
      <section>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Sets directory</h2>
            <p className="text-xs text-slate-500">
              Sortable, filterable table of all sets across the four supported
              collections
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Sort
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SetsDirectorySort)}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-violet-500/50"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Min coverage
            </label>
            <select
              value={minCoverage}
              onChange={(e) => setMinCoverage(Number(e.target.value))}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-violet-500/50"
            >
              {COVERAGE_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
              Limit
            </label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-md border border-slate-700 bg-slate-900 px-2 py-1 text-sm text-slate-200 focus:outline-none focus:border-violet-500/50"
            >
              {LIMIT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        {directoryLoading && !directory ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
            Loading directory…
          </div>
        ) : !directory || directory.rows.length === 0 ? (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-8 text-center text-sm text-slate-500">
            No sets match the current filters.
          </div>
        ) : (
          <div className="rounded-xl border border-slate-800 bg-slate-900/40 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-slate-500 font-semibold border-b border-slate-800 bg-slate-900/60">
                    <th className="py-2.5 px-4">Set</th>
                    <th className="py-2.5 px-3">Collection</th>
                    <th className="py-2.5 px-3">Series</th>
                    <th className="py-2.5 px-3 text-right">Editions</th>
                    <th className="py-2.5 px-3">Coverage</th>
                    <th className="py-2.5 px-3 text-right">Median FMV</th>
                    <th className="py-2.5 px-3 text-right">Robust total</th>
                    <th className="py-2.5 px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {directory.rows.map((row) => {
                    const series = seriesLabel(row.collection, row.series)
                    const outlier = !!row.outlier_flag
                    return (
                      <tr
                        key={row.set_id}
                        className={
                          "border-b border-slate-800/60 last:border-b-0 transition-colors " +
                          (outlier
                            ? "bg-amber-500/5 hover:bg-amber-500/10"
                            : "hover:bg-slate-900/40")
                        }
                      >
                        <td className="py-3 px-4">
                          <Link
                            href={`/analytics/sets/${row.set_id}`}
                            className="text-slate-100 font-medium hover:text-violet-400 transition-colors"
                          >
                            {row.set_name}
                          </Link>
                          {row.set_external_id ? (
                            <div className="text-[10px] text-slate-500 font-mono">
                              {row.set_external_id}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3 px-3">
                          <CollectionChip collection={row.collection} />
                        </td>
                        <td className="py-3 px-3 text-xs text-slate-300">
                          {series}
                        </td>
                        <td className="py-3 px-3 text-right text-slate-300 tabular-nums">
                          {formatNumber(row.edition_count)}
                        </td>
                        <td className="py-3 px-3">
                          <CoverageBar pct={row.coverage_pct ?? 0} />
                        </td>
                        <td className="py-3 px-3 text-right text-slate-300 tabular-nums">
                          {formatUsd(row.median_fmv_usd)}
                        </td>
                        <td className="py-3 px-3 text-right text-slate-100 font-semibold tabular-nums">
                          {formatUsd(row.total_fmv_robust_usd)}
                        </td>
                        <td className="py-3 px-3">
                          <div className="inline-flex items-center gap-1.5">
                            {outlier ? (
                              <span
                                title="One or more editions have FMV more than 20× the set median, suggesting outlier prices (often listing-reward farming asks). The robust total caps these to 20× median."
                                className="text-amber-400"
                              >
                                <AlertTriangle size={12} />
                              </span>
                            ) : null}
                            <Link
                              href={`/analytics/sets/${row.set_id}`}
                              aria-label={`View ${row.set_name}`}
                              className="text-slate-500 hover:text-violet-400 transition-colors"
                            >
                              <ArrowUpRight size={14} />
                            </Link>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <footer className="flex flex-wrap items-center gap-3 text-xs text-slate-500 pt-4 border-t border-slate-800">
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          FMV refresh every ~10 min · catalog daily
        </span>
        <span className="text-slate-700">·</span>
        <Link
          href="/analytics/methodology/sets"
          className="hover:text-violet-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
        </Link>
        {summary?.as_of ? (
          <>
            <span className="text-slate-700">·</span>
            <span>As of {new Date(summary.as_of).toLocaleString()}</span>
          </>
        ) : null}
      </footer>
    </div>
  )
}
