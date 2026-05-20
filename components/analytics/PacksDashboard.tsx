"use client"

import { useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { ArrowUpRight, BarChart3, Sparkles, TimerReset, Zap } from "lucide-react"

// Per-collection summary slot — fields per the analytics_packs_summary RPC.
interface PacksSummaryCollectionStats {
  packs_tracked?: number
  sellable_packs?: number
  positive_ev_packs?: number
  avg_value_ratio?: number | null
  median_pack_price?: number | null
  total_unopened?: number | null
  last_refresh?: string | null
  minutes_since_refresh?: number | null
}

interface PacksSummaryResponse {
  collections?: Record<string, PacksSummaryCollectionStats>
  as_of?: string
  note?: string
}

interface PacksTopEvRow {
  rank: number
  collection: string
  pack_listing_id: string
  pack_name: string | null
  pack_price: number | null
  pack_ev: number | null
  value_ratio: number | null
  fmv_coverage_pct: number | null
  edition_count: number | null
  total_unopened: number | null
  depletion_pct: number | null
  snapshotted_at: string | null
}

interface PacksFreshRow {
  rank: number
  collection: string
  pack_listing_id: string
  pack_name: string | null
  pack_price: number | null
  pack_ev: number | null
  value_ratio: number | null
  is_positive_ev: boolean | null
  total_unopened: number | null
  first_seen_at: string | null
}

const ALL_COLLECTIONS = [
  { key: "topshot", label: "Top Shot" },
  { key: "allday", label: "All Day" },
  { key: "golazos", label: "Golazos" },
  { key: "pinnacle", label: "Pinnacle" },
  { key: "ufc", label: "UFC Strike" },
] as const

const COLLECTION_LABEL: Record<string, string> = {
  topshot: "Top Shot",
  allday: "All Day",
  golazos: "Golazos",
  pinnacle: "Pinnacle",
  ufc: "UFC Strike",
}

function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

function formatNumber(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

function formatRatio(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(2)}x`
}

function formatPct(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—"
  return `${n.toFixed(digits)}%`
}

function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—"
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return "—"
  const diff = Date.now() - t
  const m = Math.floor(diff / 60000)
  if (m < 1) return "just now"
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

function CollectionPanel({
  collectionKey,
  stats,
}: {
  collectionKey: string
  stats: PacksSummaryCollectionStats
}) {
  const label = COLLECTION_LABEL[collectionKey] ?? collectionKey
  const tracked = Number(stats.packs_tracked ?? 0)
  const sellable = Number(stats.sellable_packs ?? 0)
  const positive = Number(stats.positive_ev_packs ?? 0)
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div>
          <h3 className="text-base font-semibold text-zinc-100">{label}</h3>
          <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold mt-0.5">
            Updated {stats.minutes_since_refresh != null ? `${stats.minutes_since_refresh}m ago` : "—"}
          </p>
        </div>
        <Sparkles size={16} className="text-teal-400" />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Packs tracked</div>
          <div className="text-2xl font-bold text-zinc-50 tabular-nums">{formatNumber(tracked)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Sellable</div>
          <div className="text-2xl font-bold text-zinc-50 tabular-nums">{formatNumber(sellable)}</div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Positive EV</div>
          <div className="text-2xl font-bold tabular-nums" style={{ color: positive > 0 ? "var(--rpc-success)" : "var(--rpc-text-muted)" }}>
            {formatNumber(positive)}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Avg ratio</div>
          <div className="text-2xl font-bold text-zinc-50 tabular-nums">{formatRatio(stats.avg_value_ratio)}</div>
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
        <span>
          Median price <span className="text-zinc-200">{formatUsd(stats.median_pack_price)}</span>
        </span>
        <span className="text-zinc-700">·</span>
        <span>
          Unopened <span className="text-zinc-200">{formatNumber(stats.total_unopened)}</span>
        </span>
      </div>
    </div>
  )
}

function MutedPanel({ label }: { label: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/30 p-5 opacity-70">
      <h3 className="text-base font-semibold text-zinc-300">{label}</h3>
      <p className="mt-2 text-sm text-zinc-500">Pack analytics not yet available for this collection.</p>
    </div>
  )
}

function CollectionChips({
  active,
  onChange,
}: {
  active: string[]
  onChange: (next: string[]) => void
}) {
  const allActive = active.length === 0
  function toggle(key: string) {
    if (active.includes(key)) {
      onChange(active.filter((c) => c !== key))
    } else {
      onChange([...active, key])
    }
  }
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
      <div className="flex flex-col gap-2">
        <div>
          <h1 className="text-2xl font-bold text-zinc-50 tracking-tight">Pack Analytics</h1>
          <p className="text-sm text-zinc-400 mt-1">
            Live expected value, pull odds, and freshly listed pack drops across every Flow ecosystem.
          </p>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => onChange([])}
            className={
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
              (allActive
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
            }
          >
            All
          </button>
          {ALL_COLLECTIONS.map((c) => {
            const isActive = active.includes(c.key)
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => toggle(c.key)}
                className={
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors " +
                  (isActive
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
                    : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200")
                }
              >
                {c.label}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export default function PacksDashboard() {
  const [activeCollections, setActiveCollections] = useState<string[]>([])
  const [summary, setSummary] = useState<PacksSummaryResponse | null>(null)
  const [topEv, setTopEv] = useState<PacksTopEvRow[] | null>(null)
  const [fresh, setFresh] = useState<PacksFreshRow[] | null>(null)
  const [loading, setLoading] = useState(true)

  const collectionsQs = useMemo(
    () => (activeCollections.length > 0 ? activeCollections.join(",") : ""),
    [activeCollections]
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const collectionsParam = collectionsQs ? `&collections=${encodeURIComponent(collectionsQs)}` : ""
    const summaryUrl = `/api/analytics/packs/summary${collectionsQs ? `?collections=${encodeURIComponent(collectionsQs)}` : ""}`
    const topEvUrl = `/api/analytics/packs/top-ev?direction=pumping&limit=20${collectionsParam}`
    const freshUrl = `/api/analytics/packs/fresh?hours=24&limit=20${collectionsParam}`
    Promise.all([
      fetch(summaryUrl).then((r) => (r.ok ? r.json() : null)),
      fetch(topEvUrl).then((r) => (r.ok ? r.json() : null)),
      fetch(freshUrl).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([s, e, f]) => {
        if (cancelled) return
        setSummary(s as PacksSummaryResponse | null)
        setTopEv(((e?.rows as PacksTopEvRow[] | undefined) ?? []))
        setFresh(((f?.rows as PacksFreshRow[] | undefined) ?? []))
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [collectionsQs])

  // Aggregate KPIs across the collections returned by summary.
  const kpis = useMemo(() => {
    const out = { tracked: 0, positive: 0, weightedRatio: 0, weightSum: 0, medianSamples: [] as number[], confident: 0 }
    const cols = summary?.collections ?? {}
    for (const [, s] of Object.entries(cols)) {
      const t = Number(s?.packs_tracked ?? 0)
      const p = Number(s?.positive_ev_packs ?? 0)
      const r = s?.avg_value_ratio != null ? Number(s.avg_value_ratio) : null
      out.tracked += t
      out.positive += p
      if (r != null && t > 0) {
        out.weightedRatio += r * t
        out.weightSum += t
      }
      if (s?.median_pack_price != null && Number.isFinite(s.median_pack_price)) {
        out.medianSamples.push(Number(s.median_pack_price))
      }
    }
    const wMedian = out.medianSamples.length > 0
      ? out.medianSamples.sort((a, b) => a - b)[Math.floor(out.medianSamples.length / 2)]
      : null
    return {
      tracked: out.tracked,
      positive: out.positive,
      avgRatio: out.weightSum > 0 ? out.weightedRatio / out.weightSum : null,
      medianPrice: wMedian,
      pctPositive: out.tracked > 0 ? (out.positive / out.tracked) * 100 : 0,
    }
  }, [summary])

  const summaryCollectionKeys = useMemo(() => {
    return Object.keys(summary?.collections ?? {})
  }, [summary])

  return (
    <div className="space-y-8">
      <CollectionChips active={activeCollections} onChange={setActiveCollections} />

      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Packs Tracked</div>
          <div className="mt-1 text-2xl font-bold text-zinc-50 tabular-nums">{formatNumber(kpis.tracked)}</div>
          <div className="text-[11px] text-zinc-500 mt-1">across {summaryCollectionKeys.length} collections</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Positive-EV Packs</div>
          <div className="mt-1 text-2xl font-bold tabular-nums" style={{ color: "var(--rpc-success)" }}>
            {formatNumber(kpis.positive)}
          </div>
          <div className="text-[11px] text-zinc-500 mt-1">{formatPct(kpis.pctPositive, 1)} of tracked</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Median Pack Price</div>
          <div className="mt-1 text-2xl font-bold text-zinc-50 tabular-nums">{formatUsd(kpis.medianPrice)}</div>
          <div className="text-[11px] text-zinc-500 mt-1">across collections</div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">Avg Value Ratio</div>
          <div className="mt-1 text-2xl font-bold text-zinc-50 tabular-nums">{formatRatio(kpis.avgRatio)}</div>
          <div className="text-[11px] text-zinc-500 mt-1">weighted by packs</div>
        </div>
      </div>

      {/* Per-collection cards */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-zinc-100">Per-collection breakdown</h2>
          <p className="text-xs text-zinc-500">Pack inventory, EV, and depletion by ecosystem</p>
        </div>
        {loading && !summary ? (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-8 text-center text-sm text-zinc-500">
            Loading summary…
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {ALL_COLLECTIONS.map((c) => {
              const stats = summary?.collections?.[c.key]
              if (!stats || (Number(stats.packs_tracked ?? 0) === 0 && Number(stats.sellable_packs ?? 0) === 0)) {
                return <MutedPanel key={c.key} label={c.label} />
              }
              return <CollectionPanel key={c.key} collectionKey={c.key} stats={stats} />
            })}
          </div>
        )}
      </section>

      {/* Top EV table */}
      <section>
        <div className="mb-4 flex items-baseline justify-between">
          <div>
            <h2 className="text-lg font-semibold text-zinc-100 inline-flex items-center gap-2">
              <Zap size={16} className="text-amber-400" />
              Top EV
            </h2>
            <p className="text-xs text-zinc-500">Highest value-ratio packs currently listed</p>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          {loading && !topEv ? (
            <div className="h-32 animate-pulse bg-zinc-900/60" />
          ) : !topEv || topEv.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">No positive-EV packs in this filter.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-500 font-semibold border-b border-zinc-800 bg-zinc-900/60">
                    <th className="py-2.5 px-4">#</th>
                    <th className="py-2.5 px-3">Collection</th>
                    <th className="py-2.5 px-3">Pack</th>
                    <th className="py-2.5 px-3 text-right">Price</th>
                    <th className="py-2.5 px-3 text-right">EV</th>
                    <th className="py-2.5 px-3 text-right">Ratio</th>
                    <th className="py-2.5 px-3 text-right">Coverage</th>
                    <th className="py-2.5 px-3 text-right">Unopened</th>
                  </tr>
                </thead>
                <tbody>
                  {topEv.map((r) => (
                    <tr key={r.pack_listing_id} className="border-b border-zinc-800/60 hover:bg-zinc-900/40 transition-colors">
                      <td className="py-3 px-4 text-zinc-500 tabular-nums">{r.rank}</td>
                      <td className="py-3 px-3">
                        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-zinc-300">
                          {COLLECTION_LABEL[r.collection] ?? r.collection}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-zinc-100 font-medium">{r.pack_name ?? "—"}</td>
                      <td className="py-3 px-3 text-right text-zinc-300 tabular-nums">{formatUsd(r.pack_price)}</td>
                      <td className="py-3 px-3 text-right text-zinc-100 font-semibold tabular-nums">{formatUsd(r.pack_ev)}</td>
                      <td
                        className="py-3 px-3 text-right tabular-nums font-semibold"
                        style={{ color: (r.value_ratio ?? 0) >= 1 ? "var(--rpc-success)" : "var(--rpc-text-muted)" }}
                      >
                        {formatRatio(r.value_ratio)}
                      </td>
                      <td className="py-3 px-3 text-right text-zinc-300 tabular-nums">{formatPct(r.fmv_coverage_pct, 0)}</td>
                      <td className="py-3 px-3 text-right text-zinc-300 tabular-nums">{formatNumber(r.total_unopened)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      {/* Fresh drops */}
      <section>
        <div className="mb-4">
          <h2 className="text-lg font-semibold text-zinc-100">Fresh drops</h2>
          <p className="text-xs text-zinc-500">Packs first seen in the last 24h</p>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 overflow-hidden">
          {loading && !fresh ? (
            <div className="h-32 animate-pulse bg-zinc-900/60" />
          ) : !fresh || fresh.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">No new pack listings in the last 24 hours.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-widest text-zinc-500 font-semibold border-b border-zinc-800 bg-zinc-900/60">
                    <th className="py-2.5 px-4">#</th>
                    <th className="py-2.5 px-3">Collection</th>
                    <th className="py-2.5 px-3">Pack</th>
                    <th className="py-2.5 px-3 text-right">Price</th>
                    <th className="py-2.5 px-3 text-right">EV</th>
                    <th className="py-2.5 px-3 text-right">Ratio</th>
                    <th className="py-2.5 px-3 text-right">Unopened</th>
                    <th className="py-2.5 px-3 text-right">First seen</th>
                  </tr>
                </thead>
                <tbody>
                  {fresh.map((r) => (
                    <tr key={r.pack_listing_id} className="border-b border-zinc-800/60 hover:bg-zinc-900/40 transition-colors">
                      <td className="py-3 px-4 text-zinc-500 tabular-nums">{r.rank}</td>
                      <td className="py-3 px-3">
                        <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider font-semibold text-zinc-300">
                          {COLLECTION_LABEL[r.collection] ?? r.collection}
                        </span>
                      </td>
                      <td className="py-3 px-3 text-zinc-100 font-medium">{r.pack_name ?? "—"}</td>
                      <td className="py-3 px-3 text-right text-zinc-300 tabular-nums">{formatUsd(r.pack_price)}</td>
                      <td className="py-3 px-3 text-right text-zinc-100 font-semibold tabular-nums">{formatUsd(r.pack_ev)}</td>
                      <td
                        className="py-3 px-3 text-right tabular-nums font-semibold"
                        style={{ color: (r.value_ratio ?? 0) >= 1 ? "var(--rpc-success)" : "var(--rpc-text-muted)" }}
                      >
                        {formatRatio(r.value_ratio)}
                      </td>
                      <td className="py-3 px-3 text-right text-zinc-300 tabular-nums">{formatNumber(r.total_unopened)}</td>
                      <td className="py-3 px-3 text-right text-zinc-500 tabular-nums">{relativeTime(r.first_seen_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <footer className="flex flex-wrap items-center gap-3 text-xs text-zinc-500 pt-4 border-t border-zinc-800">
        <span className="inline-flex items-center gap-1.5">
          <TimerReset size={12} />
          {summary?.as_of ? `As of ${new Date(summary.as_of).toLocaleString()}` : "Refreshing…"}
        </span>
        <span className="text-zinc-700">·</span>
        <Link
          href="/analytics/methodology/packs"
          className="hover:text-teal-400 transition-colors inline-flex items-center gap-1"
        >
          <BarChart3 size={12} />
          Methodology
          <ArrowUpRight size={11} />
        </Link>
      </footer>
    </div>
  )
}
