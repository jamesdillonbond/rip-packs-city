"use client"

import { useEffect, useMemo, useState } from "react"
import { fetchJson } from "@/lib/analytics/fetch-json"
import Link from "next/link"
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  Info,
  Sparkles,
  TimerReset,
} from "lucide-react"
import type {
  FmvConfidence,
  FmvPipelineCollectionStats,
  FmvPipelineHealthResponse,
  FmvTierPulseRow,
  FmvTopMoverRow,
} from "@/lib/analytics-types"
import {
  FMV_COLLECTIONS,
  COLLECTION_LABEL,
  WINDOW_OPTIONS,
  MIN_FMV_OPTIONS,
  LIMIT_OPTIONS,
  TIER_COLOR,
  formatUsd,
  formatNumber,
  formatPct,
  formatChangePct,
  formatChangeUsd,
  formatMinutesAgo,
  isLinkableEditionId,
  resolveConfidenceStyle,
  buildCollectionsQs,
  toggleCollection as toggleCollectionList,
  shouldHideTopMovers,
  isThinMover,
  filterHealthEntries,
  groupTierPulseByCollection,
  bucketCollectionTiers,
  tierSharePct,
  pctHighConf,
} from "@/lib/analytics-fmv-dashboard-compute"

function ConfidenceBadge({ value }: { value: FmvConfidence | null }) {
  const s = resolveConfidenceStyle(value)
  if (!s) return <span className="text-[color:var(--rpc-text-ghost)]">—</span>
  return (
    <span
      className={
        "inline-block rounded border px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold " +
        s.cls
      }
    >
      {s.label}
    </span>
  )
}

function PipelineHealthPanel({
  collectionKey,
  stats,
}: {
  collectionKey: string
  stats: FmvPipelineCollectionStats
}) {
  const label = COLLECTION_LABEL[collectionKey] ?? collectionKey
  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-[color:var(--rpc-text-primary)]">{label}</h3>
          <p className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mt-0.5">
            Updated {formatMinutesAgo(stats.minutes_since_refresh)}
          </p>
        </div>
        <Sparkles size={16} className="text-teal-400" />
      </div>

      <div className="mb-1">
        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold mb-1">
          Reliable total FMV
        </div>
        <div className="text-4xl font-bold text-[color:var(--rpc-text-primary)] tabular-nums leading-none">
          {formatUsd(stats.reliable_total_fmv_usd)}
        </div>
        <div className="text-xs text-[color:var(--rpc-text-secondary)] mt-2">
          Avg {formatUsd(stats.reliable_avg_fmv_usd)} per edition · {formatNumber(stats.editions_total)} editions tracked
        </div>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <span className="rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-[10px] uppercase tracking-wider font-semibold text-emerald-400">
          {formatNumber(stats.high_confidence)} High
        </span>
        <span className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] uppercase tracking-wider font-semibold text-amber-400">
          {formatNumber(stats.medium_confidence)} Med
        </span>
        <span className="rounded border border-[color:var(--rpc-border)] bg-[color:var(--rpc-surface-raised)] px-2 py-1 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]">
          {formatNumber(stats.low_confidence)} Low
        </span>
        <span
          className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] uppercase tracking-wider font-semibold text-rose-400 inline-flex items-center gap-1"
          title="Ask-only editions are excluded from aggregates — listing-reward farming asks pollute the data"
        >
          <AlertTriangle size={10} />
          {formatNumber(stats.ask_only)} Ask only
        </span>
      </div>
    </div>
  )
}

interface TopMoversResponse {
  rows: FmvTopMoverRow[]
  window_days: number
  direction: "gainers" | "losers"
  min_fmv: number
}

interface TierPulseResponse {
  rows: FmvTierPulseRow[]
}

function TopMoversTable({
  rows,
  loading,
  direction,
  failed = false,
}: {
  rows: FmvTopMoverRow[]
  loading: boolean
  direction: "gainers" | "losers"
  /** The backing read errored — we do not know what the movers are. */
  failed?: boolean
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center">
        <p className="text-sm text-[color:var(--rpc-text-muted)]">
          {loading
            ? "Loading movers…"
            : failed
              // The old copy told the reader to widen their window or drop the
              // FMV floor. On a failed read that is advice to fix a filter that
              // is not the problem, and it presents an outage as a finding
              // about the market.
              ? "Couldn't load top movers right now."
              : "No significant movers in this window — try a longer time range or lower min FMV floor."}
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold border-b border-[color:var(--rpc-border)] bg-[var(--rpc-surface)]">
              <th className="py-2.5 px-4">#</th>
              <th className="py-2.5 px-3">Collection</th>
              <th className="py-2.5 px-3">Edition</th>
              <th className="py-2.5 px-3 text-right">Current FMV</th>
              <th className="py-2.5 px-3 text-right">Prior FMV</th>
              <th className="py-2.5 px-3 text-right">Change</th>
              <th className="py-2.5 px-3 text-right">% Change</th>
              <th className="py-2.5 px-3">Confidence</th>
              <th className="py-2.5 px-3 text-right">Sales 7d</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const collectionLabel =
                COLLECTION_LABEL[row.collection?.toLowerCase()] ?? row.collection
              const isThinData = isThinMover(row)
              const positive = (row.change_pct ?? 0) >= 0
              const linkable = isLinkableEditionId(row.edition_id)
              const editionLabel = (
                <div className="flex flex-col leading-tight">
                  <span className="text-[color:var(--rpc-text-primary)] font-medium">
                    {row.player_name || "—"}
                  </span>
                  <span className="text-[11px] text-[color:var(--rpc-text-muted)]">
                    {row.set_name || "—"}
                  </span>
                </div>
              )

              return (
                <tr
                  key={row.edition_id}
                  className="border-b border-[color:var(--rpc-border-subtle)] hover:bg-[color:var(--rpc-surface-hover)] transition-colors"
                >
                  <td className="py-3 px-4 text-[color:var(--rpc-text-muted)] tabular-nums">
                    {row.rank}
                  </td>
                  <td className="py-3 px-3">
                    <span className="rounded border border-[color:var(--rpc-border)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]">
                      {collectionLabel}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    {linkable ? (
                      <Link
                        href={`/edition/${row.edition_id}`}
                        className="hover:text-teal-400 transition-colors"
                      >
                        {editionLabel}
                      </Link>
                    ) : (
                      editionLabel
                    )}
                  </td>
                  <td className="py-3 px-3 text-right text-[color:var(--rpc-text-primary)] font-semibold tabular-nums">
                    {formatUsd(row.current_fmv_usd)}
                  </td>
                  <td className="py-3 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                    {formatUsd(row.prior_fmv_usd)}
                  </td>
                  <td
                    className={
                      "py-3 px-3 text-right tabular-nums font-semibold " +
                      (positive ? "text-emerald-400" : "text-rose-400")
                    }
                  >
                    {formatChangeUsd(row.change_usd)}
                  </td>
                  <td className="py-3 px-3 text-right tabular-nums">
                    <span
                      className={
                        "inline-flex items-center gap-1 font-semibold " +
                        (positive ? "text-emerald-400" : "text-rose-400")
                      }
                    >
                      {positive ? <ArrowUp size={11} /> : <ArrowDown size={11} />}
                      {formatChangePct(row.change_pct)}
                    </span>
                  </td>
                  <td className="py-3 px-3">
                    <ConfidenceBadge value={row.current_confidence} />
                  </td>
                  <td className="py-3 px-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                    <span className="inline-flex items-center gap-1.5">
                      {isThinData ? (
                        <span
                          title="Thin data — single-sale or interpolated FMV; this mover may be noise"
                          className="inline-flex items-center"
                        >
                          <AlertTriangle size={11} className="text-amber-400" />
                        </span>
                      ) : null}
                      {formatNumber(row.sales_count_7d)}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function TierPulseSection({ rows, failed = false }: { rows: FmvTierPulseRow[]; failed?: boolean }) {
  // Group rows by collection.
  const byCollection = useMemo(() => groupTierPulseByCollection(rows), [rows])

  if (byCollection.size === 0) {
    return (
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center">
        <p className="text-sm text-[color:var(--rpc-text-muted)]">
          {failed ? "Couldn't load tier data right now." : "No tier data available."}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {Array.from(byCollection.entries()).map(([collectionKey, collectionRows]) => {
        const label = COLLECTION_LABEL[collectionKey] ?? collectionKey
        // Bucket rows by tier (Common, Fandom, Rare, Legendary, Ultimate, Other).
        const { visible, total } = bucketCollectionTiers(collectionRows)

        return (
          <div
            key={collectionKey}
            className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-6"
          >
            <div className="flex items-baseline justify-between mb-4">
              <h3 className="text-base font-semibold text-[color:var(--rpc-text-primary)]">{label}</h3>
              <span className="text-xs text-[color:var(--rpc-text-muted)]">
                {formatUsd(total)} total reliable FMV
              </span>
            </div>

            {/* Stacked bar */}
            <div className="mb-3">
              <div className="flex h-8 w-full overflow-hidden rounded-md border border-[color:var(--rpc-border)]">
                {visible.map((r) => {
                  const pct = tierSharePct(r.total_fmv_usd, total)
                  if (pct <= 0) return null
                  return (
                    // brand-exception: dark label sits on a tier-colored fill (style backgroundColor below)
                    <div
                      key={r.tier ?? "Other"}
                      className="flex items-center justify-center text-[10px] font-semibold text-zinc-900"
                      style={{
                        width: `${pct}%`,
                        backgroundColor:
                          TIER_COLOR[r.tier ?? "Other"] ?? TIER_COLOR.Other,
                      }}
                      title={`${r.tier ?? "Other"} · ${formatUsd(r.total_fmv_usd)} (${pct.toFixed(1)}%)`}
                    >
                      {pct >= 8 ? formatUsd(r.total_fmv_usd) : ""}
                    </div>
                  )
                })}
              </div>
              <div className="flex flex-wrap gap-3 mt-2">
                {visible.map((r) => (
                  <div
                    key={r.tier ?? "Other"}
                    className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[color:var(--rpc-text-secondary)]"
                  >
                    <span
                      className="inline-block h-2 w-2 rounded-sm"
                      style={{
                        backgroundColor:
                          TIER_COLOR[r.tier ?? "Other"] ?? TIER_COLOR.Other,
                      }}
                    />
                    {r.tier ?? "Other"}
                  </div>
                ))}
              </div>
            </div>

            {/* Tier table */}
            <div className="overflow-x-auto mt-4">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold border-b border-[color:var(--rpc-border)]">
                    <th className="py-2 pr-3">Tier</th>
                    <th className="py-2 pr-3 text-right">Editions</th>
                    <th className="py-2 pr-3 text-right">Total FMV</th>
                    <th className="py-2 pr-3 text-right">Avg FMV</th>
                    <th className="py-2 pr-3 text-right">Median FMV</th>
                    <th className="py-2 pr-0 text-right">% High conf</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((r) => {
                    const pctHigh = pctHighConf(r.high_conf_count, r.edition_count)
                    return (
                      <tr
                        key={r.tier ?? "Other"}
                        className="border-b border-[color:var(--rpc-border-subtle)]"
                      >
                        <td className="py-2 pr-3">
                          <span className="inline-flex items-center gap-2">
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-sm"
                              style={{
                                backgroundColor:
                                  TIER_COLOR[r.tier ?? "Other"] ??
                                  TIER_COLOR.Other,
                              }}
                            />
                            <span className="text-[color:var(--rpc-text-primary)] font-medium">
                              {r.tier ?? "Other"}
                            </span>
                          </span>
                        </td>
                        <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                          {formatNumber(r.edition_count)}
                        </td>
                        <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-primary)] tabular-nums">
                          {formatUsd(r.total_fmv_usd)}
                        </td>
                        <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                          {formatUsd(r.avg_fmv_usd)}
                        </td>
                        <td className="py-2 pr-3 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                          {formatUsd(r.median_fmv_usd)}
                        </td>
                        <td className="py-2 pr-0 text-right text-[color:var(--rpc-text-secondary)] tabular-nums">
                          {formatPct(pctHigh, 0)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default function FmvDashboard() {
  const [activeCollections, setActiveCollections] = useState<string[]>([])
  const [direction, setDirection] = useState<"gainers" | "losers">("gainers")
  const [windowDays, setWindowDays] = useState<1 | 7 | 30>(7)
  const [minFmv, setMinFmv] = useState<number>(5)
  const [limit, setLimit] = useState<number>(25)

  const [health, setHealth] = useState<FmvPipelineHealthResponse | null>(null)
  const [moversResp, setMoversResp] = useState<TopMoversResponse | null>(null)
  const [tierResp, setTierResp] = useState<TierPulseResponse | null>(null)
  const [moversLoading, setMoversLoading] = useState(true)
  const [healthLoading, setHealthLoading] = useState(true)
  const [tierLoading, setTierLoading] = useState(true)
  // These three reads previously called `.then((r) => r.json())` with no status
  // check at all, so a 500's error envelope was stored as the response and its
  // absent `rows` became [] — a failure rendered as a market finding.
  const [moversFailed, setMoversFailed] = useState(false)
  const [tierFailed, setTierFailed] = useState(false)

  const collectionsQs = useMemo(
    () => buildCollectionsQs(activeCollections),
    [activeCollections]
  )

  // Pipeline health is collection-agnostic (the response has all collections).
  useEffect(() => {
    let cancelled = false
    setHealthLoading(true)
    fetchJson<FmvPipelineHealthResponse>("/api/analytics/fmv/health")
      .then((res) => {
        if (cancelled) return
        if (res.ok) setHealth(res.json)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setHealthLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Tier pulse responds to the collection filter.
  useEffect(() => {
    let cancelled = false
    setTierLoading(true)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)
    fetchJson<TierPulseResponse>(`/api/analytics/fmv/tier-pulse?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return
        setTierFailed(!res.ok)
        if (res.ok) setTierResp(res.json)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setTierLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionsQs])

  // Top movers — also responds to direction/window/min_fmv/limit.
  useEffect(() => {
    let cancelled = false
    setMoversLoading(true)
    const qs = new URLSearchParams()
    if (collectionsQs) qs.set("collections", collectionsQs)
    qs.set("direction", direction)
    qs.set("window_days", String(windowDays))
    qs.set("min_fmv", String(minFmv))
    qs.set("limit", String(limit))
    fetchJson<TopMoversResponse>(`/api/analytics/fmv/top-movers?${qs.toString()}`)
      .then((res) => {
        if (cancelled) return
        setMoversFailed(!res.ok)
        if (res.ok) setMoversResp(res.json)
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setMoversLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [collectionsQs, direction, windowDays, minFmv, limit])

  function toggleCollection(key: string) {
    setActiveCollections((curr) => toggleCollectionList(curr, key))
  }

  // Pipeline health — only render collections we got data for.
  const healthEntries = useMemo(
    () => filterHealthEntries(health?.collections, activeCollections),
    [health, activeCollections]
  )

  return (
    <div className="space-y-10">
      {/* Header + filter chips */}
      <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold text-[color:var(--rpc-text-primary)] tracking-tight">
            FMV Index — Fair Market Value Across Flow NFTs
          </h1>
          <p className="text-sm text-[color:var(--rpc-text-secondary)] max-w-2xl">
            Algorithmic pricing across Top Shot, All Day, Pinnacle, Golazos, and UFC Strike editions.
            Refreshes every 10 minutes.
          </p>
        </div>

        <div className="mt-4 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-bg)] p-3 flex items-start gap-2">
          <Info size={14} className="text-teal-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-[color:var(--rpc-text-secondary)] leading-relaxed">
            Aggregates exclude{" "}
            <code className="font-mono text-rose-300">ASK_ONLY</code> confidence
            editions (unsold inventory with farming-tier asks).{" "}
            <Link
              href="/analytics/methodology/fmv"
              className="text-teal-400 hover:text-teal-300 underline"
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
                ? "border-teal-500/40 bg-teal-500/10 text-teal-400"
                : "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
            }
          >
            All collections
          </button>
          {FMV_COLLECTIONS.map((c) => {
            const active = activeCollections.includes(c.key)
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggleCollection(c.key)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                  (active
                    ? "border-teal-500/40 bg-teal-500/10 text-teal-400"
                    : "border-[color:var(--rpc-border)] text-[color:var(--rpc-text-secondary)] hover:border-[color:var(--rpc-border)] hover:text-[color:var(--rpc-text-primary)]")
                }
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>

      {/* Pipeline health */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Pipeline health</h2>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">
            Per-collection confidence breakdown and refresh state
          </p>
        </div>
        {healthLoading && !health ? (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            Loading pipeline health…
          </div>
        ) : healthEntries.length === 0 ? (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            No pipeline data available.
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {healthEntries.map(([key, stats]) => (
              <PipelineHealthPanel
                key={key}
                collectionKey={key.toLowerCase()}
                stats={stats}
              />
            ))}
          </div>
        )}
      </section>

      {/* Top movers — hidden when every active collection is unsupported by analytics_fmv_top_movers */}
      {!shouldHideTopMovers(activeCollections) && (
      <section>
        <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Top movers</h2>
            <p className="text-xs text-[color:var(--rpc-text-muted)]">
              Editions with the largest FMV changes in the selected window
            </p>
          </div>
        </div>

        {/* Filters */}
        <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4 mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:flex-wrap">
          <div className="inline-flex rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-bg)] p-0.5">
            <button
              type="button"
              onClick={() => setDirection("gainers")}
              className={
                "px-3 py-1.5 text-xs font-semibold rounded transition-colors inline-flex items-center gap-1.5 " +
                (direction === "gainers"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)]")
              }
            >
              <ArrowUp size={12} />
              Gainers
            </button>
            <button
              type="button"
              onClick={() => setDirection("losers")}
              className={
                "px-3 py-1.5 text-xs font-semibold rounded transition-colors inline-flex items-center gap-1.5 " +
                (direction === "losers"
                  ? "bg-rose-500/15 text-rose-400"
                  : "text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)]")
              }
            >
              <ArrowDown size={12} />
              Losers
            </button>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold">
              Window
            </span>
            <div className="inline-flex rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-bg)] p-0.5">
              {WINDOW_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setWindowDays(opt.value)}
                  className={
                    "px-2.5 py-1 text-xs font-semibold rounded transition-colors " +
                    (windowDays === opt.value
                      ? "bg-teal-500/15 text-teal-400"
                      : "text-[color:var(--rpc-text-secondary)] hover:text-[color:var(--rpc-text-primary)]")
                  }
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="fmv-min"
              className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold"
            >
              Min FMV
            </label>
            <select
              id="fmv-min"
              value={minFmv}
              onChange={(e) => setMinFmv(Number(e.target.value))}
              className="rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-2 py-1 text-sm text-[color:var(--rpc-text-primary)] focus:outline-none focus:border-teal-500/50"
            >
              {MIN_FMV_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  ${v}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2">
            <label
              htmlFor="fmv-limit"
              className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)] font-semibold"
            >
              Limit
            </label>
            <select
              id="fmv-limit"
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
              className="rounded-md border border-[color:var(--rpc-border)] bg-[var(--rpc-surface-raised)] px-2 py-1 text-sm text-[color:var(--rpc-text-primary)] focus:outline-none focus:border-teal-500/50"
            >
              {LIMIT_OPTIONS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </div>
        </div>

        <TopMoversTable
          rows={moversResp?.rows ?? []}
          loading={moversLoading}
          direction={direction}
          failed={moversFailed}
        />
      </section>
      )}

      {/* Tier pulse */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-[color:var(--rpc-text-primary)]">Tier pulse</h2>
          <p className="text-xs text-[color:var(--rpc-text-muted)]">
            FMV distribution across rarity tiers per collection
          </p>
        </div>
        {tierLoading && !tierResp ? (
          <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-sm text-[color:var(--rpc-text-muted)]">
            Loading tier data…
          </div>
        ) : (
          <TierPulseSection rows={tierResp?.rows ?? []} failed={tierFailed} />
        )}
      </section>

      <footer className="flex flex-wrap items-center gap-3 text-xs text-[color:var(--rpc-text-muted)] pt-4 border-t border-[color:var(--rpc-border)]">
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          Refreshes every 10 min
        </span>
        <span className="text-[color:var(--rpc-text-ghost)]">·</span>
        <Link
          href="/analytics/methodology/fmv"
          className="hover:text-teal-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
        </Link>
        {health?.as_of ? (
          <>
            <span className="text-[color:var(--rpc-text-ghost)]">·</span>
            <span>
              Pipeline as of {new Date(health.as_of).toLocaleString()}
            </span>
          </>
        ) : null}
      </footer>
    </div>
  )
}
