"use client"

import { fetchJson } from "@/lib/analytics/fetch-json"

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
import {
  SET_COLLECTIONS,
  COLLECTION_LABEL,
  COLLECTION_COLOR,
  TIER_ORDER,
  TIER_LABEL,
  TIER_COLOR,
  SORT_OPTIONS,
  COVERAGE_OPTIONS,
  LIMIT_OPTIONS,
  formatUsd,
  formatNumber,
  formatPct,
  clampPct,
  collectionChipLabel,
  collectionChipColor,
  tierMixTotal,
  tierMixPct,
  coveragePct,
  medianAverage,
  buildCollectionsQs,
  toggleCollection as toggleCollectionList,
  buildSeriesChart,
  seriesCollectionsPresent,
  buildSeriesTableRows,
} from "@/lib/analytics-sets-dashboard-compute"

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
  const clamped = clampPct(pct)
  return (
    <div className="flex items-center gap-2 min-w-[110px]">
      <div className="h-1.5 flex-1 overflow-hidden rounded bg-[color:var(--rpc-surface-raised)]">
        <div
          className="h-full bg-violet-500/70"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs tabular-nums text-[color:var(--rpc-text-secondary)] w-9 text-right">
        {clamped.toFixed(0)}%
      </span>
    </div>
  )
}

function CollectionChip({ collection }: { collection: string }) {
  const label = collectionChipLabel(collection)
  const color = collectionChipColor(collection)
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded border border-[color:var(--rpc-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]"
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
  const total = tierMixTotal(tierBreakdown)
  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-[color:var(--rpc-text-primary)]">{label}</h3>
          <p className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mt-0.5">
            {COLLECTION_LABEL[collectionKey] ?? collectionKey}
          </p>
        </div>
        <Layers
          size={16}
          style={{ color: COLLECTION_COLOR[collectionKey] ?? "#a1a1aa" }}
        />
      </div>

      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mb-1">
            Sets
          </div>
          <div className="text-3xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums leading-none">
            {formatNumber(setCount)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mb-1">
            Editions
          </div>
          <div className="text-3xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums leading-none">
            {formatNumber(editionCount)}
          </div>
        </div>
      </div>

      <div>
        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mb-2">
          Tier mix
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded border border-[color:var(--rpc-border)]">
          {TIER_ORDER.map((t) => {
            const count = tierBreakdown[t] || 0
            const pct = tierMixPct(count, total)
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
                className="flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]"
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
  const { chartData, labels } = useMemo(() => buildSeriesChart(rows), [rows])

  const collectionsPresent = useMemo(
    () => seriesCollectionsPresent(rows),
    [rows]
  )

  // Aggregate-per-label rollup for the table below the chart. MUST be declared
  // before any early return — a conditional `return` between hooks changes the
  // hook count across renders (empty vs non-empty rows) and throws React's
  // "rendered fewer hooks than during the previous render".
  const tableRows = useMemo(
    () => buildSeriesTableRows(rows, labels),
    [rows, labels]
  )

  if (chartData.length === 0) {
    return (
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
        No series data available.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 8, right: 16, bottom: 24, left: 0 }}
            >
              <CartesianGrid strokeDasharray="2 4" stroke="#1f2937" />
              <XAxis
                dataKey="series_label"
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                interval={0}
                angle={-15}
                textAnchor="end"
                height={48}
                stroke="#3f3f46"
              />
              <YAxis
                tick={{ fill: "#a1a1aa", fontSize: 11 }}
                stroke="#3f3f46"
                tickFormatter={(v) => formatUsd(v)}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "#18181b",
                  border: "1px solid #27272a",
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
                  fill={COLLECTION_COLOR[c] ?? "#a1a1aa"}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold border-b border-[color:var(--rpc-border)] bg-[var(--rpc-surface)]">
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
                const coverage = coveragePct(
                  r.edition_count_with_fmv,
                  r.edition_count
                )
                const medAvg = medianAverage(r.median_total, r.median_count)
                const unmapped = isUnmappedSeriesLabel(r.series_label)
                return (
                  <tr
                    key={r.series_label}
                    className="border-b border-[color:var(--rpc-border-subtle)] last:border-b-0 hover:bg-[color:var(--rpc-surface-hover)] transition-colors"
                  >
                    <td className="py-2.5 px-4 text-[color:var(--rpc-text-primary)]">
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
                    <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                      {formatNumber(r.set_count)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                      {formatNumber(r.edition_count)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                      {formatPct(coverage, 0)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                      {formatUsd(medAvg)}
                    </td>
                    <td className="py-2.5 px-3 text-right text-[color:var(--rpc-text-primary)] font-semibold tabular-nums">
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

  const [loadFailed, setLoadFailed] = useState(false)
  const [summaryLoading, setSummaryLoading] = useState(true)
  const [seriesLoading, setSeriesLoading] = useState(true)
  const [directoryLoading, setDirectoryLoading] = useState(true)

  const collectionsQs = useMemo(
    () => buildCollectionsQs(activeCollections),
    [activeCollections]
  )

  useEffect(() => {
    let cancelled = false
    setSummaryLoading(true)
    setLoadFailed(false)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)
    fetchJson<SetsSummaryResponse>(`/api/analytics/sets/summary?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return
        // ⚠ Was `.then((r) => r.json())` then `setSummary(j as SetsSummaryResponse)`. A failing
        // route answers with a well-formed JSON envelope, so the parse SUCCEEDS
        // and the ERROR OBJECT reached state — truthy, so every
        // `x ? … : "—"` guard downstream took its DATA branch and formatted
        // undefined into "$0" / "0". Writing null is what restores the guard.
        if (!res.ok) setLoadFailed(true)
        setSummary(res.ok ? res.json : null)
      })
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
    fetchJson<SeriesResponse>(`/api/analytics/sets/series?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return
        // ⚠ Was `.then((r) => r.json())` then `setSeriesResp(j as SeriesResponse)`. A failing
        // route answers with a well-formed JSON envelope, so the parse SUCCEEDS
        // and the ERROR OBJECT reached state — truthy, so every
        // `x ? … : "—"` guard downstream took its DATA branch and formatted
        // undefined into "$0" / "0". Writing null is what restores the guard.
        if (!res.ok) setLoadFailed(true)
        setSeriesResp(res.ok ? res.json : null)
      })
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
    fetchJson<DirectoryResponse>(`/api/analytics/sets/directory?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return
        // ⚠ Was `.then((r) => r.json())` then `setDirectory(j as DirectoryResponse)`. A failing
        // route answers with a well-formed JSON envelope, so the parse SUCCEEDS
        // and the ERROR OBJECT reached state — truthy, so every
        // `x ? … : "—"` guard downstream took its DATA branch and formatted
        // undefined into "$0" / "0". Writing null is what restores the guard.
        if (!res.ok) setLoadFailed(true)
        setDirectory(res.ok ? res.json : null)
      })
      .finally(() => {
        if (!cancelled) setDirectoryLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionsQs, sort, minCoverage, limit])

  function toggleCollection(key: string) {
    setActiveCollections((curr) => toggleCollectionList(curr, key))
  }

  const summaryCollections = (summary?.collections ?? {}) as Record<
    string,
    { set_count: number; edition_count: number; tier_breakdown: Record<string, number> }
  >

  return (
    <div className="space-y-10">
      {loadFailed && (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-[color:var(--rpc-red-border)] bg-[var(--rpc-red-bg)] px-4 py-3 text-sm text-[color:var(--rpc-text-muted)]"
        >
          Couldn&apos;t load some of this data just now &mdash; the figures below are
          shown as &mdash; rather than guessed. This says nothing about the market.
        </div>
      )}
      {/* Header + filter chips */}
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tracking-tight">
            Sets — Catalog Across Flow NFT Collections
          </h1>
          <p className="text-sm text-[color:var(--rpc-text-secondary)] max-w-2xl">
            Set-level rollups across NBA Top Shot, NFL All Day, LaLiga Golazos,
            and UFC Strike. Pinnacle has a separate set structure and is
            excluded.
          </p>
        </div>

        <div className="mt-4 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-bg)] p-3 flex items-start gap-2">
          <Info size={14} className="text-violet-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-[color:var(--rpc-text-secondary)] leading-relaxed">
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
                : "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
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
                    : "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
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
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Catalog summary</h2>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">
            Set + edition counts per collection, with tier mix
          </p>
        </div>
        {summaryLoading && !summary ? (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
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
                    className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-5 opacity-60"
                  >
                    <h3 className="text-base font-semibold text-[color:var(--rpc-text-secondary)]">
                      {c.label}
                    </h3>
                    <p className="text-xs text-[color:var(--rpc-text-muted)] mt-1">No data</p>
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
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Series overview</h2>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">
            How robust value distributes across series eras, segmented by
            collection
          </p>
        </div>
        {seriesLoading && !seriesResp ? (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
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
            <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Sets directory</h2>
            <p className="text-xs text-[color:var(--rpc-text-muted)]">
              Sortable, filterable table of all sets across the four supported
              collections
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4 mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
              Sort
            </label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SetsDirectorySort)}
              className="rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-2 py-1 text-sm text-[color:var(--rpc-text-primary)] focus:outline-none focus:border-violet-500/50"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
              Min coverage
            </label>
            <select
              value={minCoverage}
              onChange={(e) => setMinCoverage(Number(e.target.value))}
              className="rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-2 py-1 text-sm text-[color:var(--rpc-text-primary)] focus:outline-none focus:border-violet-500/50"
            >
              {COVERAGE_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}%
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
              Limit
            </label>
            <select
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-2 py-1 text-sm text-[color:var(--rpc-text-primary)] focus:outline-none focus:border-violet-500/50"
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
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            Loading directory…
          </div>
        ) : !directory || directory.rows.length === 0 ? (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            No sets match the current filters.
          </div>
        ) : (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold border-b border-[color:var(--rpc-border)] bg-[var(--rpc-surface)]">
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
                          "border-b border-[color:var(--rpc-border-subtle)] last:border-b-0 transition-colors " +
                          (outlier
                            ? "bg-amber-500/5 hover:bg-amber-500/10"
                            : "hover:bg-[color:var(--rpc-surface-hover)]")
                        }
                      >
                        <td className="py-3 px-4">
                          <Link
                            href={`/analytics/sets/${row.set_id}`}
                            className="text-[color:var(--rpc-text-primary)] font-medium hover:text-violet-400 transition-colors"
                          >
                            {row.set_name}
                          </Link>
                          {row.set_external_id ? (
                            <div className="text-[10px] text-[color:var(--rpc-text-muted)] font-mono">
                              {row.set_external_id}
                            </div>
                          ) : null}
                        </td>
                        <td className="py-3 px-3">
                          <CollectionChip collection={row.collection} />
                        </td>
                        <td className="py-3 px-3 text-xs text-[color:var(--rpc-text-secondary)]">
                          {series}
                        </td>
                        <td className="py-3 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                          {formatNumber(row.edition_count)}
                        </td>
                        <td className="py-3 px-3">
                          <CoverageBar pct={row.coverage_pct ?? 0} />
                        </td>
                        <td className="py-3 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                          {formatUsd(row.median_fmv_usd)}
                        </td>
                        <td className="py-3 px-3 text-right text-[color:var(--rpc-text-primary)] font-semibold tabular-nums">
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
                              className="text-[color:var(--rpc-text-muted)] hover:text-violet-400 transition-colors"
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

      <footer className="flex flex-wrap items-center gap-3 text-xs text-[color:var(--rpc-text-muted)] pt-4 border-t border-[color:var(--rpc-border)]">
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          FMV refresh every ~10 min · catalog daily
        </span>
        <span className="text-[color:var(--rpc-text-ghost)]">·</span>
        <Link
          href="/analytics/methodology/sets"
          className="hover:text-violet-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
        </Link>
        {summary?.as_of ? (
          <>
            <span className="text-[color:var(--rpc-text-ghost)]">·</span>
            <span>As of {new Date(summary.as_of).toLocaleString()}</span>
          </>
        ) : null}
      </footer>
    </div>
  )
}
