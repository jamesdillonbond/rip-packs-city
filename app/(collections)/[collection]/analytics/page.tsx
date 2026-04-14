"use client"

import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, Legend, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, BarChart, Bar,
} from "recharts"
import { getCollection } from "@/lib/collections"

type MarketplaceBreakdown = {
  topshot?: { count: number; total_spent: number; avg_price: number } | null
  flowty?: { count: number; total_spent: number; avg_price: number } | null
  summary?: { total_purchases?: number; total_spent?: number; flowty_pct?: number; topshot_pct?: number } | null
  [k: string]: unknown
}

type AnalyticsResponse = {
  wallet: string
  acquisition: {
    pack_pull_count: number
    marketplace_count: number
    challenge_reward_count: number
    gift_count: number
    total_tracked: number
  }
  locked: {
    locked_count: number
    unlocked_count: number
    locked_fmv: number
    unlocked_fmv: number
  }
  tiers: Array<{ tier: string; count: number; fmv: number }>
  series: Array<{ label: string; seriesNumber: number; count: number; fmv: number }>
  confidence: Record<string, number>
  total_fmv: number
  total_moments: number
  portfolio_clarity_score: number
}

const TIER_COLOR: Record<string, string> = {
  ULTIMATE: "var(--tier-ultimate)",
  LEGENDARY: "var(--tier-legendary)",
  RARE: "var(--tier-rare)",
  FANDOM: "var(--tier-fandom)",
  COMMON: "var(--tier-common)",
}

// Explicit hex tier colors for recharts (Tailwind vars can't be read by SVG)
const TIER_HEX: Record<string, string> = {
  ULTIMATE: "#FFD700",
  LEGENDARY: "#A855F7",
  RARE: "#3B82F6",
  FANDOM: "#22C55E",
  COMMON: "#6B7280",
}

type TopSale = {
  price_usd: number
  sold_at: string
  serial_number: number | null
  marketplace: string | null
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
}

type TierAnalyticsRow = {
  tier: string
  sale_count: number
  volume: number
  avg_price: number
  min_price: number
  max_price: number
}

type TopEditionRow = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  circulation_count: number | null
  sale_count: number
  volume: number
  avg_price: number
}

type DailyTierRow = {
  date: string
  tier: string
  sale_count: number
  volume: number
  avg_price: number
}

type BadgePremiumRow = {
  tier: string
  badged_avg: number
  badged_sales: number
  unbadged_avg: number
  unbadged_sales: number
  premium_pct: number
}

type SeriesAnalyticsRow = {
  series: number | null
  sale_count: number
  volume: number
  avg_price: number
  max_sale: number
}

type DailySeriesRow = {
  date: string
  series: number | null
  sale_count: number
  volume: number
}

type PlayerSearchRow = {
  player_name: string | null
  set_name: string | null
  tier: string | null
  series: number | null
  sale_count: number
  volume: number
  avg_price: number
  min_price: number
  max_price: number
  edition_key?: string | null
}

type MarketAnalyticsResponse = {
  period: string
  startDate: string
  endDate: string
  totals: { totalSales: number; totalVolume: number }
  daily: Array<{ date: string; marketplace: string; saleCount: number; volume: number }>
  topSales?: TopSale[]
  tierAnalytics?: TierAnalyticsRow[]
  topEditions?: TopEditionRow[]
  dailyTierVolume?: DailyTierRow[]
  badgePremium?: BadgePremiumRow[]
  seriesAnalytics?: SeriesAnalyticsRow[]
  dailySeriesVolume?: DailySeriesRow[]
  playerSearch?: PlayerSearchRow[]
  periodComparison?: {
    current?: { volume?: number; sales?: number; avgPrice?: number; uniqueEditions?: number }
    previous?: { volume?: number; sales?: number; avgPrice?: number; uniqueEditions?: number }
    changes?: { volumePct?: number | null; salesPct?: number | null; avgPricePct?: number | null; uniqueEditionsPct?: number | null }
  } | null
}

function seriesLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Unknown"
  switch (n) {
    case 0: return "Series 1"
    case 1: return "Series 1"
    case 2: return "Series 2"
    case 3: return "Summer 2021"
    case 4: return "Series 3"
    case 5: return "Series 4"
    case 6: return "2023-24"
    case 7: return "2024-25"
    case 8: return "2025-26"
    default: return "Unknown"
  }
}

const SERIES_COLORS = ["#14B8A6", "#A855F7", "#F59E0B", "#3B82F6", "#EF4444", "#22C55E", "#F472B6", "#EAB308", "#60A5FA"]

function pivotDailySeries(
  rows: DailySeriesRow[] | undefined,
  topSeriesKeys: string[]
): Array<Record<string, string | number>> {
  if (!rows || rows.length === 0) return []
  const byDate = new Map<string, Record<string, string | number>>()
  for (const r of rows) {
    const key = seriesLabel(r.series)
    if (!topSeriesKeys.includes(key)) continue
    const bucket = byDate.get(r.date) ?? { date: r.date }
    bucket[key] = Number(bucket[key] ?? 0) + Number(r.volume ?? 0)
    byDate.set(r.date, bucket)
  }
  const data = Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  )
  for (const row of data) {
    for (const k of topSeriesKeys) if (row[k] === undefined) row[k] = 0
  }
  return data
}


function ChangeBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null || !Number.isFinite(pct) || pct === 0) {
    return <span className="text-[10px] text-zinc-500">— 0%</span>
  }
  const up = pct > 0
  const color = up ? "#22C55E" : "#EF4444"
  const arrow = up ? "\u25B2" : "\u25BC"
  return (
    <span className="text-[11px] font-mono" style={{ color }}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function KpiCard(props: { label: string; value: string; pct?: number | null; period: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{props.label}</div>
      <div className="mt-1 font-mono text-2xl font-black text-white">{props.value}</div>
      <div className="mt-1 flex items-center gap-2">
        <ChangeBadge pct={props.pct} />
        <span className="text-[9px] uppercase tracking-widest text-zinc-600">vs prev {props.period}</span>
      </div>
    </div>
  )
}

function pivotDailyTier<T extends "sale_count" | "volume" | "avg_price">(
  rows: DailyTierRow[] | undefined,
  field: T
): { data: Array<Record<string, string | number>>; tiers: string[] } {
  if (!rows || rows.length === 0) return { data: [], tiers: [] }
  const byDate = new Map<string, Record<string, string | number>>()
  const tierSet = new Set<string>()
  for (const r of rows) {
    if (!r.tier || r.tier === "UNKNOWN") continue
    tierSet.add(r.tier)
    const bucket = byDate.get(r.date) ?? { date: r.date }
    bucket[r.tier] = Number(r[field] ?? 0)
    byDate.set(r.date, bucket)
  }
  const data = Array.from(byDate.values()).sort((a, b) =>
    String(a.date).localeCompare(String(b.date))
  )
  // Fill missing tier keys with 0 so charts render cleanly.
  const tiers = Array.from(tierSet)
  for (const row of data) {
    for (const t of tiers) if (row[t] === undefined) row[t] = 0
  }
  return { data, tiers }
}

function relativeDate(iso: string): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ""
  const diff = Date.now() - t
  const d = Math.floor(diff / 86400000)
  if (d < 1) {
    const h = Math.floor(diff / 3600000)
    if (h < 1) return "just now"
    return `${h}h ago`
  }
  if (d < 30) return `${d}d ago`
  return new Date(iso).toISOString().slice(0, 10)
}

function fmtUsd(n: number): string {
  return `$${(Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function fmt(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(2)}`
}

function AnalyticsInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const collection = params?.collection as string
  const urlWallet = searchParams.get("wallet") || ""

  const [input, setInput] = useState(urlWallet)
  const [activeWallet, setActiveWallet] = useState(urlWallet)
  const [data, setData] = useState<AnalyticsResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mpBreakdown, setMpBreakdown] = useState<MarketplaceBreakdown | null>(null)
  const [marketData, setMarketData] = useState<MarketAnalyticsResponse | null>(null)
  const [marketLoading, setMarketLoading] = useState(false)
  const [playerQuery, setPlayerQuery] = useState("")
  const [playerResults, setPlayerResults] = useState<PlayerSearchRow[] | null>(null)
  const [playerLoading, setPlayerLoading] = useState(false)

  const collectionMeta = useMemo(() => getCollection(collection), [collection])
  const accent = collectionMeta?.accent ?? "#EF4444"

  useEffect(() => {
    if (!collection) return
    let cancelled = false
    setMarketLoading(true)
    fetch(`/api/market-analytics?collection=${encodeURIComponent(collection)}&period=30d&detail=full&comparison=true`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j && !j.error) setMarketData(j as MarketAnalyticsResponse) })
      .catch(() => { /* swallow */ })
      .finally(() => { if (!cancelled) setMarketLoading(false) })
    return () => { cancelled = true }
  }, [collection])

  const volumeByTier = useMemo(() => {
    if (!marketData?.tierAnalytics) return []
    return marketData.tierAnalytics
      .filter((t) => t.tier && t.tier !== "UNKNOWN" && Number(t.volume) > 0)
      .map((t) => ({ name: t.tier, value: Math.round(Number(t.volume) * 100) / 100 }))
  }, [marketData?.tierAnalytics])

  const avgPricePivot = useMemo(
    () => pivotDailyTier(marketData?.dailyTierVolume, "avg_price"),
    [marketData?.dailyTierVolume]
  )
  const saleCountPivot = useMemo(
    () => pivotDailyTier(marketData?.dailyTierVolume, "sale_count"),
    [marketData?.dailyTierVolume]
  )

  const seriesVolumeBars = useMemo(() => {
    if (!marketData?.seriesAnalytics) return []
    return marketData.seriesAnalytics
      .map((s) => ({
        name: seriesLabel(s.series),
        volume: Math.round(Number(s.volume) * 100) / 100,
        avg_price: Number(s.avg_price) || 0,
        sale_count: Number(s.sale_count) || 0,
      }))
      .filter((s) => s.volume > 0)
      .sort((a, b) => b.volume - a.volume)
  }, [marketData?.seriesAnalytics])

  const topSeriesKeys = useMemo(() => {
    return seriesVolumeBars.slice(0, 5).map((s) => s.name)
  }, [seriesVolumeBars])

  const dailySeriesPivot = useMemo(
    () => pivotDailySeries(marketData?.dailySeriesVolume, topSeriesKeys),
    [marketData?.dailySeriesVolume, topSeriesKeys]
  )

  // Debounced player search
  useEffect(() => {
    const q = playerQuery.trim()
    if (!q) { setPlayerResults(null); return }
    const timer = setTimeout(async () => {
      setPlayerLoading(true)
      try {
        const res = await fetch(
          `/api/market-analytics?collection=${encodeURIComponent(collection)}&period=30d&detail=full&player=${encodeURIComponent(q)}`
        )
        if (res.ok) {
          const j = await res.json()
          setPlayerResults(j.playerSearch ?? [])
        }
      } catch { /* swallow */ }
      finally { setPlayerLoading(false) }
    }, 500)
    return () => clearTimeout(timer)
  }, [playerQuery, collection])

  const exportCsv = useCallback(() => {
    if (!marketData?.daily || marketData.daily.length === 0) return
    const headers = ["Date", "Marketplace", "Sales", "Volume", "Avg Price"]
    const rows = marketData.daily.map((d) => {
      const avg = d.saleCount > 0 ? (d.volume / d.saleCount) : 0
      return [d.date, d.marketplace, d.saleCount, d.volume.toFixed(2), avg.toFixed(2)].join(",")
    })
    const csv = [headers.join(","), ...rows].join("\n")
    const blob = new Blob([csv], { type: "text/csv" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `${collection}-analytics-${marketData.period}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }, [marketData, collection])

  const runSearch = useCallback(async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    setData(null)
    setMpBreakdown(null)
    setActiveWallet(trimmed)
    try { router.replace(`?wallet=${encodeURIComponent(trimmed)}`, { scroll: false }) } catch {}
    try {
      const [analyticsRes, mpRes] = await Promise.all([
        fetch(`/api/analytics?wallet=${encodeURIComponent(trimmed)}`),
        fetch(`/api/marketplace-breakdown?wallet=${encodeURIComponent(trimmed)}`),
      ])
      const json = await analyticsRes.json()
      if (!analyticsRes.ok) throw new Error(json.error || "Failed to load analytics")
      setData(json)
      if (mpRes.ok) {
        const mp = await mpRes.json()
        setMpBreakdown(mp && typeof mp === "object" && !mp.error ? mp : null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analytics")
    } finally {
      setLoading(false)
    }
  }, [router])

  useEffect(() => {
    if (urlWallet && !data && !loading) runSearch(urlWallet)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlWallet])

  const acq = data?.acquisition
  const acqTotal = acq ? (acq.pack_pull_count + acq.marketplace_count + acq.challenge_reward_count + acq.gift_count) : 0
  const pctPack = acq && acqTotal > 0 ? (acq.pack_pull_count / acqTotal) * 100 : 0
  const pctMarket = acq && acqTotal > 0 ? (acq.marketplace_count / acqTotal) * 100 : 0
  const pctReward = acq && acqTotal > 0 ? (acq.challenge_reward_count / acqTotal) * 100 : 0
  const pctGift = acq && acqTotal > 0 ? (acq.gift_count / acqTotal) * 100 : 0

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <form
        onSubmit={(e) => { e.preventDefault(); runSearch(input) }}
        className="mb-6 flex flex-col gap-2 sm:flex-row"
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Wallet address or username"
          className="flex-1 rounded-lg border border-zinc-800 bg-black px-4 py-2 text-white placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none font-mono"
        />
        <button
          type="submit"
          disabled={loading || !input.trim()}
          className="rounded-lg border border-zinc-700 bg-zinc-900 px-5 py-2 font-semibold text-white hover:bg-zinc-800 disabled:opacity-50"
        >
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </form>

      {error && <div className="mb-4 rounded-lg border border-red-900/40 bg-red-950/20 p-3 text-sm text-red-300">{error}</div>}

      {!data && !loading && !error && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-8 text-center text-zinc-500">
          Enter a wallet address or Top Shot username to see portfolio analytics.
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* Section 1 — Portfolio Origin Story */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Portfolio Origin Story</div>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Packs Pulled</div>
                <div className="font-mono text-3xl font-black" style={{ color: "rgb(20,184,166)" }}>{acq?.pack_pull_count.toLocaleString() ?? "—"}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Marketplace Buys</div>
                <div className="font-mono text-3xl font-black text-zinc-300">{acq?.marketplace_count.toLocaleString() ?? "—"}</div>
              </div>
              <div>
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Challenge Rewards</div>
                <div className="font-mono text-3xl font-black" style={{ color: "rgb(245,158,11)" }}>{acq?.challenge_reward_count.toLocaleString() ?? "—"}</div>
              </div>
            </div>
            {acqTotal > 0 && (
              <div className="mt-4">
                <div className="flex h-3 w-full overflow-hidden rounded-full border border-zinc-800">
                  {pctPack > 0 && <div style={{ width: `${pctPack}%`, background: "rgb(20,184,166)" }} />}
                  {pctMarket > 0 && <div style={{ width: `${pctMarket}%`, background: "rgb(161,161,170)" }} />}
                  {pctReward > 0 && <div style={{ width: `${pctReward}%`, background: "rgb(245,158,11)" }} />}
                  {pctGift > 0 && <div style={{ width: `${pctGift}%`, background: "rgb(96,165,250)" }} />}
                </div>
                <div className="mt-2 flex flex-wrap gap-4 font-mono text-[11px] text-zinc-500">
                  <span>Pack {pctPack.toFixed(0)}%</span>
                  <span>Market {pctMarket.toFixed(0)}%</span>
                  <span>Reward {pctReward.toFixed(0)}%</span>
                  {pctGift > 0 && <span>Gift {pctGift.toFixed(0)}%</span>}
                </div>
              </div>
            )}
          </section>

          {/* Section 2 — Liquid vs Locked */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Liquid vs Locked</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Unlocked FMV</div>
                <div className="font-mono text-2xl font-black text-white">{fmt(data.locked.unlocked_fmv)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{data.locked.unlocked_count.toLocaleString()} moments</div>
              </div>
              <div className="rounded-lg border border-zinc-800 bg-black p-3">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">Locked FMV</div>
                <div className="font-mono text-2xl font-black text-white">{fmt(data.locked.locked_fmv)}</div>
                <div className="mt-1 text-[11px] text-zinc-500">{data.locked.locked_count.toLocaleString()} moments</div>
              </div>
            </div>
            <div className="mt-2 text-[11px] text-zinc-600">Locked moments cannot be listed or traded.</div>
          </section>

          {/* Marketplace Breakdown — Top Shot vs Flowty */}
          {mpBreakdown && (() => {
            const ts = mpBreakdown.topshot ?? { count: 0, total_spent: 0, avg_price: 0 }
            const fl = mpBreakdown.flowty ?? { count: 0, total_spent: 0, avg_price: 0 }
            const total = (ts.count || 0) + (fl.count || 0)
            if (total === 0) return null
            const tsPct = total > 0 ? (ts.count / total) * 100 : 0
            const flPct = total > 0 ? (fl.count / total) * 100 : 0
            const flowtyPctSummary = typeof mpBreakdown.summary?.flowty_pct === "number" ? mpBreakdown.summary!.flowty_pct : flPct
            return (
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 flex items-center justify-between">
                  <div className="text-[11px] uppercase tracking-widest text-zinc-500">Marketplace Breakdown</div>
                  <div className="font-mono text-[11px] text-zinc-500">Flowty {Number(flowtyPctSummary).toFixed(1)}%</div>
                </div>

                {/* Horizontal split bar */}
                <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full border border-zinc-800">
                  {tsPct > 0 && <div style={{ width: `${tsPct}%`, background: "var(--rpc-red)" }} title={`Top Shot ${tsPct.toFixed(1)}%`} />}
                  {flPct > 0 && <div style={{ width: `${flPct}%`, background: "#14B8A6" }} title={`Flowty ${flPct.toFixed(1)}%`} />}
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-zinc-800 bg-black p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Top Shot</div>
                      <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold" style={{ color: "var(--rpc-red)", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.10)" }}>TS</span>
                    </div>
                    <div className="mt-1 font-mono text-xl font-black text-white">{(ts.count ?? 0).toLocaleString()}</div>
                    <div className="mt-1 text-[11px] text-zinc-500">purchases · {fmt(Number(ts.total_spent ?? 0))}</div>
                    <div className="mt-1 text-[11px] text-zinc-600">avg {fmt(Number(ts.avg_price ?? 0))}</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-black p-3">
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] uppercase tracking-widest text-zinc-500">Flowty</div>
                      <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold" style={{ color: "#14B8A6", border: "1px solid rgba(20,184,166,0.35)", background: "rgba(20,184,166,0.10)" }}>Flowty</span>
                    </div>
                    <div className="mt-1 font-mono text-xl font-black text-white">{(fl.count ?? 0).toLocaleString()}</div>
                    <div className="mt-1 text-[11px] text-zinc-500">purchases · {fmt(Number(fl.total_spent ?? 0))}</div>
                    <div className="mt-1 text-[11px] text-zinc-600">avg {fmt(Number(fl.avg_price ?? 0))}</div>
                  </div>
                </div>

                <div className="mt-3 text-[11px] text-zinc-600">
                  Avg price gap:{" "}
                  {ts.avg_price > 0 && fl.avg_price > 0
                    ? `${fmt(Math.abs(Number(fl.avg_price) - Number(ts.avg_price)))} ${Number(fl.avg_price) > Number(ts.avg_price) ? "higher on Flowty" : "higher on Top Shot"}`
                    : "—"}
                </div>
              </section>
            )
          })()}

          {/* Section 3 — Tier Breakdown */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Tier Breakdown</div>
            <div className="space-y-2">
              {data.tiers.map((t) => {
                const maxFmv = data.tiers.reduce((m, x) => Math.max(m, x.fmv), 0)
                const w = maxFmv > 0 ? (t.fmv / maxFmv) * 100 : 0
                const color = TIER_COLOR[t.tier] ?? "var(--tier-common)"
                return (
                  <div key={t.tier} className="flex items-center gap-3">
                    <div className="w-28 shrink-0 font-mono text-xs font-bold" style={{ color }}>{t.tier}</div>
                    <div className="relative flex-1 h-5 rounded bg-zinc-900 overflow-hidden">
                      <div className="absolute inset-y-0 left-0" style={{ width: `${w}%`, background: color, opacity: 0.35 }} />
                      <div className="absolute inset-0 flex items-center px-2 font-mono text-[11px] text-zinc-300">
                        {t.count.toLocaleString()} · {fmt(t.fmv)}
                      </div>
                    </div>
                  </div>
                )
              })}
              {data.tiers.length === 0 && <div className="text-sm text-zinc-500">No tier data.</div>}
            </div>
          </section>

          {/* Section 4 — Series Breakdown */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Series Breakdown</div>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                  <th className="pb-2">Series</th>
                  <th className="pb-2 text-right">Moments</th>
                  <th className="pb-2 text-right">Total FMV</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {data.series.map((s) => (
                  <tr key={s.label} className="border-b border-zinc-900">
                    <td className="py-1.5 text-zinc-300">{s.label}</td>
                    <td className="py-1.5 text-right text-zinc-400">{s.count.toLocaleString()}</td>
                    <td className="py-1.5 text-right text-white">{fmt(s.fmv)}</td>
                  </tr>
                ))}
                {data.series.length === 0 && (
                  <tr><td colSpan={3} className="py-3 text-center text-zinc-500">No series data.</td></tr>
                )}
              </tbody>
            </table>
          </section>

          {/* Section 5 — Portfolio Clarity Score */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
              <span>Portfolio Clarity Score</span>
              <span className="text-zinc-600" title="Share of moments with HIGH or MEDIUM FMV confidence. Higher = more reliable total portfolio FMV.">ⓘ</span>
            </div>
            <div className="font-mono text-5xl font-black text-white">{data.portfolio_clarity_score.toFixed(1)}%</div>
            <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 font-mono text-xs">
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">HIGH</div>
                <div className="text-green-400">{(data.confidence.HIGH ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">MEDIUM</div>
                <div className="text-yellow-400">{(data.confidence.MEDIUM ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">LOW</div>
                <div className="text-orange-400">{(data.confidence.LOW ?? 0).toLocaleString()}</div>
              </div>
              <div className="rounded border border-zinc-800 bg-black p-2">
                <div className="text-[10px] uppercase tracking-widest text-zinc-500">NO DATA</div>
                <div className="text-zinc-500">{(data.confidence.NO_DATA ?? 0).toLocaleString()}</div>
              </div>
            </div>
            <div className="mt-3 text-[11px] text-zinc-600">How reliably we know this portfolio's FMV. Higher means most moments have HIGH or MEDIUM confidence pricing.</div>
          </section>
        </div>
      )}

      {/* ── Market analytics sections (collection-wide, not wallet-specific) ── */}
      <div className="mt-8 space-y-6">
        {/* KPI cards with period-over-period comparison */}
        {(() => {
          const pc = marketData?.periodComparison
          const cur = pc?.current
          const ch = pc?.changes
          const periodLabel = marketData?.period ?? "30d"
          const totalVolume = cur?.volume ?? marketData?.totals?.totalVolume ?? 0
          const totalSales = cur?.sales ?? marketData?.totals?.totalSales ?? 0
          const avgPrice = cur?.avgPrice ?? (totalSales > 0 ? totalVolume / totalSales : 0)
          const uniqueEds = cur?.uniqueEditions ?? 0
          return (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiCard label="Total Volume" value={fmt(totalVolume)} pct={pc ? ch?.volumePct : undefined} period={periodLabel} />
              <KpiCard label="Total Sales" value={totalSales.toLocaleString()} pct={pc ? ch?.salesPct : undefined} period={periodLabel} />
              <KpiCard label="Avg Sale Price" value={fmtUsd(avgPrice)} pct={pc ? ch?.avgPricePct : undefined} period={periodLabel} />
              <KpiCard label="Unique Editions Traded" value={uniqueEds.toLocaleString()} pct={pc ? ch?.uniqueEditionsPct : undefined} period={periodLabel} />
            </div>
          )
        })()}

        {/* Section A — Volume by Tier */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Volume by Tier
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : volumeByTier.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="h-72 w-full" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={volumeByTier}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius={50}
                    outerRadius={100}
                    stroke="#18181b"
                  >
                    {volumeByTier.map((entry, i) => (
                      <Cell key={i} fill={TIER_HEX[entry.name] ?? "#6B7280"} />
                    ))}
                  </Pie>
                  <ReTooltip
                    contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "'Share Tech Mono', monospace" }}
                    formatter={(v, n) => [fmtUsd(Number(v) || 0), String(n)]}
                  />
                  <Legend
                    formatter={(value: string, entry: any) => {
                      const v = entry?.payload?.value ?? 0
                      return <span style={{ color: "#e4e4e7" }}>{value} — {fmtUsd(v)}</span>
                    }}
                  />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Section B — Top Sales */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Top Sales
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : !marketData?.topSales || marketData.topSales.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <table className="w-full text-sm" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                  <th className="py-2 pr-2">#</th>
                  <th className="py-2 pr-2">Player</th>
                  <th className="py-2 pr-2">Set</th>
                  <th className="py-2 pr-2">Tier</th>
                  <th className="py-2 pr-2 text-right">Serial</th>
                  <th className="py-2 pr-2 text-right">Price</th>
                  <th className="py-2 text-right">Date</th>
                </tr>
              </thead>
              <tbody>
                {marketData.topSales.map((s, i) => {
                  const tier = (s.tier ?? "").toUpperCase()
                  const dot = TIER_HEX[tier] ?? "#6B7280"
                  return (
                    <tr key={i} className="border-b border-zinc-900">
                      <td className="py-1.5 pr-2 text-zinc-500">{i + 1}</td>
                      <td className="py-1.5 pr-2 text-zinc-200">{s.player_name ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-zinc-400">{s.set_name ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-zinc-300">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                          {tier || "—"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-right text-zinc-400">
                        {s.serial_number ? `#${s.serial_number}${s.circulation_count ? `/${s.circulation_count}` : ""}` : "—"}
                      </td>
                      <td className="py-1.5 pr-2 text-right text-white">{fmtUsd(s.price_usd)}</td>
                      <td className="py-1.5 text-right text-zinc-500">{relativeDate(s.sold_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* Section C — Hottest Editions */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Hottest Editions
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : !marketData?.topEditions || marketData.topEditions.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <table className="w-full text-sm" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                  <th className="py-2 pr-2">Player</th>
                  <th className="py-2 pr-2">Set</th>
                  <th className="py-2 pr-2">Tier</th>
                  <th className="py-2 pr-2 text-right">Sales</th>
                  <th className="py-2 pr-2 text-right">Volume</th>
                  <th className="py-2 text-right">Avg Price</th>
                </tr>
              </thead>
              <tbody>
                {[...marketData.topEditions]
                  .sort((a, b) => Number(b.volume) - Number(a.volume))
                  .map((e, i) => {
                    const tier = (e.tier ?? "").toUpperCase()
                    const dot = TIER_HEX[tier] ?? "#6B7280"
                    return (
                      <tr key={i} className="border-b border-zinc-900">
                        <td className="py-1.5 pr-2 text-zinc-200">{e.player_name ?? "—"}</td>
                        <td className="py-1.5 pr-2 text-zinc-400">{e.set_name ?? "—"}</td>
                        <td className="py-1.5 pr-2 text-zinc-300">
                          <span className="inline-flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                            {tier || "—"}
                          </span>
                        </td>
                        <td className="py-1.5 pr-2 text-right text-zinc-400">{Number(e.sale_count).toLocaleString()}</td>
                        <td className="py-1.5 pr-2 text-right text-white">{fmtUsd(e.volume)}</td>
                        <td className="py-1.5 text-right text-zinc-300">{fmtUsd(e.avg_price)}</td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          )}
        </section>

        {/* Section D — Average Price by Tier */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Average Price by Tier
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : avgPricePivot.tiers.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="h-72 w-full" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <ResponsiveContainer>
                <LineChart data={avgPricePivot.data}>
                  <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString()}`} />
                  <ReTooltip
                    contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "'Share Tech Mono', monospace" }}
                    formatter={(v, n) => [fmtUsd(Number(v) || 0), String(n)]}
                  />
                  <Legend />
                  {avgPricePivot.tiers.map((t) => (
                    <Line
                      key={t}
                      type="monotone"
                      dataKey={t}
                      stroke={TIER_HEX[t] ?? "#6B7280"}
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Section E — Daily Sales by Tier */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Daily Sales by Tier
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : saleCountPivot.tiers.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="h-72 w-full" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <ResponsiveContainer>
                <AreaChart data={saleCountPivot.data}>
                  <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
                  <ReTooltip
                    contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "'Share Tech Mono', monospace" }}
                  />
                  <Legend />
                  {saleCountPivot.tiers.map((t) => {
                    const hex = TIER_HEX[t] ?? "#6B7280"
                    return (
                      <Area
                        key={t}
                        type="monotone"
                        dataKey={t}
                        stackId="1"
                        stroke={hex}
                        fill={hex}
                        fillOpacity={0.6}
                      />
                    )
                  })}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Section F — Badge Premium */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-1 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Badge Premium
          </h2>
          <div className="mb-3 text-[11px] text-zinc-500">
            How much more badged editions sell for vs non-badged within the same tier
          </div>
          {marketLoading && !marketData ? (
            <div className="h-40 animate-pulse rounded bg-zinc-900" />
          ) : !marketData?.badgePremium || marketData.badgePremium.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="flex flex-wrap gap-3" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              {marketData.badgePremium.map((b) => {
                const tier = (b.tier ?? "").toUpperCase()
                const dot = TIER_HEX[tier] ?? "#6B7280"
                const pct = Number(b.premium_pct) || 0
                const pctColor = pct >= 0 ? "#22C55E" : "#EF4444"
                return (
                  <div key={tier} className="flex-1 min-w-[180px] rounded-lg border border-zinc-800 bg-black p-3">
                    <div className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                      <span className="text-xs font-bold text-zinc-200">{tier || "—"}</span>
                    </div>
                    <div className="mt-2 text-[11px] text-zinc-400">Badged Avg: <span className="text-zinc-200">{fmtUsd(Number(b.badged_avg) || 0)}</span></div>
                    <div className="text-[11px] text-zinc-400">Non-Badged Avg: <span className="text-zinc-200">{fmtUsd(Number(b.unbadged_avg) || 0)}</span></div>
                    <div className="mt-2 text-2xl font-black" style={{ color: pctColor }}>
                      {pct >= 0 ? "+" : ""}{pct.toFixed(0)}%
                    </div>
                    <div className="mt-1 text-[10px] text-zinc-500">
                      {Number(b.badged_sales).toLocaleString()} badged / {Number(b.unbadged_sales).toLocaleString()} unbadged
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Section G — Volume by Series */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Volume by Series
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : seriesVolumeBars.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="h-72 w-full" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <ResponsiveContainer>
                <BarChart data={seriesVolumeBars} layout="vertical" margin={{ left: 20 }}>
                  <defs>
                    <linearGradient id="seriesBarGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor={accent} stopOpacity={0.9} />
                      <stop offset="100%" stopColor={accent} stopOpacity={0.4} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                  <XAxis type="number" stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString()}`} />
                  <YAxis type="category" dataKey="name" stroke="#71717a" tick={{ fontSize: 10 }} width={100} />
                  <ReTooltip
                    contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "'Share Tech Mono', monospace" }}
                    formatter={(v, n, p: any) => {
                      const row = p?.payload ?? {}
                      return [
                        <span key="body">
                          {fmtUsd(Number(v) || 0)}
                          <div style={{ fontSize: 10, color: "#a1a1aa" }}>Avg {fmtUsd(row.avg_price || 0)} · {Number(row.sale_count).toLocaleString()} sales</div>
                        </span>,
                        "Volume",
                      ]
                    }}
                  />
                  <Bar dataKey="volume" fill="url(#seriesBarGrad)" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Section H — Daily Volume by Series */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Daily Volume by Series
          </h2>
          {marketLoading && !marketData ? (
            <div className="h-64 animate-pulse rounded bg-zinc-900" />
          ) : dailySeriesPivot.length === 0 ? (
            <div className="py-8 text-center text-sm text-zinc-500">No data</div>
          ) : (
            <div className="h-72 w-full" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <ResponsiveContainer>
                <AreaChart data={dailySeriesPivot}>
                  <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                  <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                  <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString()}`} />
                  <ReTooltip
                    contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "'Share Tech Mono', monospace" }}
                    formatter={(v, n) => [fmtUsd(Number(v) || 0), String(n)]}
                  />
                  <Legend />
                  {topSeriesKeys.map((s, i) => {
                    const color = SERIES_COLORS[i % SERIES_COLORS.length]
                    return (
                      <Area
                        key={s}
                        type="monotone"
                        dataKey={s}
                        stackId="1"
                        stroke={color}
                        fill={color}
                        fillOpacity={0.6}
                      />
                    )
                  })}
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </section>

        {/* Section I — Player Search */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
          <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "'Barlow Condensed', sans-serif" }}>
            Player Search
          </h2>
          <input
            value={playerQuery}
            onChange={(e) => setPlayerQuery(e.target.value)}
            placeholder="Search by player name..."
            className="mb-3 w-full rounded-lg border border-zinc-800 bg-black px-4 py-2 text-white placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none font-mono"
          />
          {!playerQuery.trim() ? (
            <div className="py-6 text-center text-sm text-zinc-500">
              Search for a player to see their marketplace analytics
            </div>
          ) : playerLoading ? (
            <div className="h-24 animate-pulse rounded bg-zinc-900" />
          ) : !playerResults || playerResults.length === 0 ? (
            <div className="py-6 text-center text-sm text-zinc-500">No results</div>
          ) : (
            <table className="w-full text-sm" style={{ fontFamily: "'Share Tech Mono', monospace" }}>
              <thead>
                <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
                  <th className="py-2 pr-2">Player</th>
                  <th className="py-2 pr-2">Set</th>
                  <th className="py-2 pr-2">Tier</th>
                  <th className="py-2 pr-2">Series</th>
                  <th className="py-2 pr-2 text-right">Sales</th>
                  <th className="py-2 pr-2 text-right">Volume</th>
                  <th className="py-2 pr-2 text-right">Avg</th>
                  <th className="py-2 pr-2 text-right">Min</th>
                  <th className="py-2 text-right">Max</th>
                </tr>
              </thead>
              <tbody>
                {playerResults.map((p, i) => {
                  const tier = (p.tier ?? "").toUpperCase()
                  const dot = TIER_HEX[tier] ?? "#6B7280"
                  const clickable = !!p.edition_key
                  return (
                    <tr
                      key={i}
                      className={`border-b border-zinc-900 ${clickable ? "cursor-pointer hover:bg-zinc-900/60" : ""}`}
                      onClick={() => {
                        if (!p.edition_key) return
                        window.open(`/api/edition-history?edition=${encodeURIComponent(p.edition_key)}&days=90`, "_blank")
                      }}
                    >
                      <td className="py-1.5 pr-2 text-zinc-200">{p.player_name ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-zinc-400">{p.set_name ?? "—"}</td>
                      <td className="py-1.5 pr-2 text-zinc-300">
                        <span className="inline-flex items-center gap-1.5">
                          <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                          {tier || "—"}
                        </span>
                      </td>
                      <td className="py-1.5 pr-2 text-zinc-400">{seriesLabel(p.series)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-400">{Number(p.sale_count).toLocaleString()}</td>
                      <td className="py-1.5 pr-2 text-right text-white">{fmtUsd(p.volume)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-300">{fmtUsd(p.avg_price)}</td>
                      <td className="py-1.5 pr-2 text-right text-zinc-500">{fmtUsd(p.min_price)}</td>
                      <td className="py-1.5 text-right text-zinc-300">{fmtUsd(p.max_price)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </section>

        {/* Section J — Export CSV */}
        <div className="flex justify-end pt-2">
          <button
            type="button"
            onClick={exportCsv}
            disabled={!marketData?.daily?.length}
            className="rounded-lg border px-5 py-2 font-semibold uppercase tracking-widest text-white disabled:opacity-50"
            style={{
              fontFamily: "'Barlow Condensed', sans-serif",
              background: accent,
              borderColor: accent,
            }}
          >
            Export CSV
          </button>
        </div>

      </div>
    </div>
  )
}

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-6 text-zinc-500">Loading…</div>}>
      <AnalyticsInner />
    </Suspense>
  )
}
