"use client"

import Link from "next/link"
import { ArrowUpRight } from "lucide-react"
import { useParams, useRouter, useSearchParams } from "next/navigation"
import { Suspense, useCallback, useEffect, useMemo, useState } from "react"
import {
  PieChart, Pie, Cell, Tooltip as ReTooltip, Legend, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  AreaChart, Area, BarChart, Bar,
} from "recharts"
import { getCollection } from "@/lib/collections"

// ── Slug mapping ────────────────────────────────────────────────────────────
// URL slug ("nba-top-shot") → RPC short slug ("topshot") used by the
// /api/analytics/* endpoints. Distinct from SLUG_TO_DB_SLUG (long form
// "nba_top_shot") which is what the sales/editions tables persist.
const URL_TO_SHORT_SLUG: Record<string, string> = {
  "nba-top-shot": "topshot",
  "nfl-all-day": "allday",
  "laliga-golazos": "golazos",
  "disney-pinnacle": "pinnacle",
  "ufc": "ufc",
}

function shortSlug(urlSlug: string): string {
  return URL_TO_SHORT_SLUG[urlSlug] ?? urlSlug
}

// ── Types ───────────────────────────────────────────────────────────────────
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
  } | null
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

// New card types — strongly typed where possible, otherwise unknown-cast at fetch.
type ListingsSummaryResponse = {
  loan_offers?: {
    count?: number
    total_principal_usd?: number
    avg_apr?: number | null
    avg_term_days?: number | null
    collections?: Record<string, { count?: number; total_principal_usd?: number }>
  } | null
  topshot_orderbook?: {
    count?: number
    median_ask_usd?: number
    p90_ask_usd?: number
    locked_count?: number
  } | null
  marketplace_listings?: Array<{
    collection: string
    count?: number
    median_ask_usd?: number
    p90_ask_usd?: number
    avg_ask_usd?: number
  }> | null
  as_of?: string
}

type FmvTierRow = {
  collection: string
  tier: string | null
  edition_count: number
  total_fmv_usd: number
  high_conf_count: number
  low_conf_count: number
}

type PacksSummaryResponse = {
  collections?: Record<string, {
    packs_tracked?: number
    sellable?: number
    positive_ev_packs?: number
    avg_value_ratio?: number
    median_pack_price?: number
  }>
  as_of?: string
}

type LeaderboardRow = {
  rank: number
  addr: string
  username?: string | null
  sale_count: number
  total_volume_usd: number
  avg_price_usd: number
  is_returning?: boolean
}

const TIER_COLOR: Record<string, string> = {
  ULTIMATE: "var(--tier-ultimate)",
  LEGENDARY: "var(--tier-legendary)",
  RARE: "var(--tier-rare)",
  FANDOM: "var(--tier-fandom)",
  COMMON: "var(--tier-common)",
}

// Explicit hex tier colors for recharts (Tailwind/CSS vars can't be read by SVG).
// Kept as fallbacks per brand-token migration policy.
const TIER_HEX: Record<string, string> = {
  ULTIMATE: "#FFD700",
  LEGENDARY: "#A855F7",
  RARE: "#3B82F6",
  FANDOM: "#22C55E",
  COMMON: "#6B7280",
}

const SERIES_COLORS = ["#14B8A6", "#A855F7", "#F59E0B", "#3B82F6", "#EF4444", "#22C55E", "#F472B6", "#EAB308", "#60A5FA"]

const MARKETPLACE_LABEL: Record<string, string> = {
  topshot: "TopShot Native",
  allday: "AllDay Native",
  golazos: "Golazos Native",
  pinnacle: "Pinnacle Native",
  flowty: "Flowty",
  "on-chain": "On-chain",
  unknown: "Unknown",
}
const MARKETPLACE_COLOR: Record<string, string> = {
  topshot: "#E03A2F",
  allday: "#4F94D4",
  golazos: "#22C55E",
  pinnacle: "#A855F7",
  flowty: "#3B82F6",
  "on-chain": "#94A3B8",
  unknown: "#6B7280",
}
function marketplaceLabel(key: string): string {
  return MARKETPLACE_LABEL[key] ?? (key.charAt(0).toUpperCase() + key.slice(1))
}
function marketplaceColor(key: string): string {
  return MARKETPLACE_COLOR[key] ?? "#6B7280"
}

function seriesLabel(n: number | null | undefined): string {
  if (n === null || n === undefined) return "Unknown"
  switch (n) {
    case 0: return "Series 1"
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

function shortAddr(addr: string): string {
  if (!addr) return "—"
  if (addr.length <= 10) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ── Reusable atoms ──────────────────────────────────────────────────────────

function ChangeBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null || !Number.isFinite(pct) || pct === 0) {
    return <span className="text-[10px] text-zinc-500">— 0%</span>
  }
  const up = pct > 0
  const color = up ? "var(--rpc-success)" : "var(--rpc-red)"
  const arrow = up ? "▲" : "▼"
  return (
    <span className="text-[11px]" style={{ color, fontFamily: "var(--font-mono)" }}>
      {arrow} {Math.abs(pct).toFixed(1)}%
    </span>
  )
}

function KpiCard(props: { label: string; value: string; pct?: number | null; period: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500">{props.label}</div>
      <div className="mt-1 text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>{props.value}</div>
      <div className="mt-1 flex items-center gap-2">
        <ChangeBadge pct={props.pct} />
        <span className="text-[9px] uppercase tracking-widest text-zinc-600">vs prev {props.period}</span>
      </div>
    </div>
  )
}

function HeaderChips({ short }: { short: string }) {
  const chips: Array<{ href: string; label: string }> = [
    { href: `/analytics/sales?collections=${short}`, label: "Sales" },
    { href: `/analytics/listings?collections=${short}`, label: "Listings" },
    { href: `/analytics/loans?collections=${short}`, label: "Loans" },
    { href: "/analytics/wallets", label: "Wallets" },
  ]
  return (
    <div className="mb-4 flex flex-wrap gap-2">
      {chips.map((c) => (
        <Link
          key={c.href}
          href={c.href}
          className="inline-flex items-center gap-1 rounded-full px-3 py-1 text-[11px] uppercase tracking-widest transition-colors"
          style={{
            border: "1px solid var(--rpc-border)",
            color: "var(--rpc-text-secondary)",
            background: "var(--rpc-surface)",
            fontFamily: "var(--font-display)",
          }}
        >
          {c.label}
          <ArrowUpRight size={11} />
        </Link>
      ))}
    </div>
  )
}

function TabNav({ active, onChange }: { active: "market" | "portfolio"; onChange: (t: "market" | "portfolio") => void }) {
  const Tab = ({ k, label }: { k: "market" | "portfolio"; label: string }) => {
    const isActive = active === k
    return (
      <button
        type="button"
        onClick={() => onChange(k)}
        className="relative px-4 py-2 text-[12px] uppercase tracking-widest"
        style={{
          fontFamily: "var(--font-display)",
          color: isActive ? "var(--rpc-text-primary)" : "var(--rpc-text-muted)",
          borderBottom: isActive ? "2px solid var(--rpc-red)" : "2px solid transparent",
        }}
      >
        {label}
      </button>
    )
  }
  return (
    <div className="mb-6 flex border-b border-zinc-800">
      <Tab k="market" label="Market" />
      <Tab k="portfolio" label="Portfolio" />
    </div>
  )
}

// ── Marketplace breakdown card (kept) ───────────────────────────────────────

function MarketplaceBreakdownCard({
  rows,
  loading,
  period,
}: {
  rows: Array<{ marketplace: string; volume: number; transactions: number }>
  loading: boolean
  period: string
}) {
  const totalVolume = rows.reduce((s, r) => s + r.volume, 0)
  const totalTx = rows.reduce((s, r) => s + r.transactions, 0)
  const enriched = rows.map((r) => ({
    ...r,
    label: marketplaceLabel(r.marketplace),
    color: marketplaceColor(r.marketplace),
    volumePct: totalVolume > 0 ? (r.volume / totalVolume) * 100 : 0,
    txPct: totalTx > 0 ? (r.transactions / totalTx) * 100 : 0,
  }))

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
        Marketplace Breakdown <span className="ml-1 text-[10px] tracking-widest text-zinc-500">/ last {period}</span>
      </h2>
      {loading ? (
        <div className="h-48 animate-pulse rounded bg-zinc-900" />
      ) : enriched.length === 0 ? (
        <div className="py-8 text-center text-sm text-zinc-500">No marketplace activity in the last {period}.</div>
      ) : enriched.length === 1 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-black/30 p-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: enriched[0].color }} />
            <span className="text-sm font-semibold text-white">{enriched[0].label}</span>
            <span className="text-[10px] uppercase tracking-widest text-zinc-500">single source</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-zinc-300">
            <span>Volume {fmt(enriched[0].volume)}</span>
            <span className="text-zinc-700">·</span>
            <span>{enriched[0].transactions.toLocaleString()} sales</span>
            <span className="text-zinc-700">·</span>
            <span style={{ color: enriched[0].color }} className="font-bold">100%</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-72" style={{ fontFamily: "var(--font-mono)" }}>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-zinc-500">USD volume</div>
            <ResponsiveContainer>
              <BarChart data={enriched} margin={{ top: 10, right: 16, bottom: 30, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="label" tick={{ fill: "#a1a1aa", fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fill: "#a1a1aa", fontSize: 10 }} tickFormatter={(v) => fmt(Number(v))} />
                <ReTooltip
                  contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }}
                  formatter={(v) => [fmtUsd(Number(v)), "Volume"] as [string, string]}
                />
                <Bar dataKey="volume" radius={[4, 4, 0, 0]}>
                  {enriched.map((r) => (
                    <Cell key={r.marketplace} fill={r.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="h-72" style={{ fontFamily: "var(--font-mono)" }}>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-zinc-500">Transactions</div>
            <ResponsiveContainer>
              <BarChart data={enriched} margin={{ top: 10, right: 16, bottom: 30, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="label" tick={{ fill: "#a1a1aa", fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fill: "#a1a1aa", fontSize: 10 }} tickFormatter={(v) => Number(v).toLocaleString()} />
                <ReTooltip
                  contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }}
                  formatter={(v) => [Number(v).toLocaleString(), "Sales"] as [string, string]}
                />
                <Bar dataKey="transactions" radius={[4, 4, 0, 0]}>
                  {enriched.map((r) => (
                    <Cell key={r.marketplace} fill={r.color} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {enriched.length >= 2 && (
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-zinc-400" style={{ fontFamily: "var(--font-mono)" }}>
          {enriched.map((r) => (
            <span key={r.marketplace} className="inline-flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              <span className="text-zinc-200">{r.label}</span>
              <span className="text-zinc-500">{fmt(r.volume)}</span>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-500">{r.volumePct.toFixed(1)}% vol</span>
              <span className="text-zinc-700">·</span>
              <span className="text-zinc-500">{r.txPct.toFixed(1)}% tx</span>
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

// ── New cards ───────────────────────────────────────────────────────────────

function OrderBookCard({ short }: { short: string }) {
  const [data, setData] = useState<ListingsSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/analytics/listings/summary?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setData(j as ListingsSummaryResponse) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const orderbook = data?.topshot_orderbook
  const fromMarket = data?.marketplace_listings?.find((m) => (m.collection || "").toLowerCase() === short)
  // For Top Shot prefer the orderbook block (locked-aware); for others read from marketplace_listings.
  const isTs = short === "topshot"
  const count = isTs ? (orderbook?.count ?? 0) : (fromMarket?.count ?? 0)
  const median = isTs ? (orderbook?.median_ask_usd ?? null) : (fromMarket?.median_ask_usd ?? null)
  const p90 = isTs ? (orderbook?.p90_ask_usd ?? null) : (fromMarket?.p90_ask_usd ?? null)

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500" style={{ fontFamily: "var(--font-display)" }}>
        Order Book Depth
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-zinc-900" />
      ) : count === 0 ? (
        <div className="mt-2 text-sm text-zinc-500">No live listings.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>
            {count.toLocaleString()} <span className="text-[11px] text-zinc-500">listings</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Median ask</div>
              <div className="text-zinc-200">{median != null ? fmt(median) : "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">P90 ask</div>
              <div className="text-zinc-200">{p90 != null ? fmt(p90) : "—"}</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function FmvHealthCard({ short }: { short: string }) {
  const [rows, setRows] = useState<FmvTierRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/analytics/fmv/tier-pulse?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j?.rows) setRows(j.rows as FmvTierRow[]) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const totals = useMemo(() => {
    const out = { high: 0, low: 0, edition: 0, fmv: 0 }
    for (const r of rows ?? []) {
      out.high += Number(r.high_conf_count) || 0
      out.low += Number(r.low_conf_count) || 0
      out.edition += Number(r.edition_count) || 0
      out.fmv += Number(r.total_fmv_usd) || 0
    }
    return out
  }, [rows])
  const total = totals.high + totals.low
  const highPct = total > 0 ? (totals.high / total) * 100 : 0
  const lowPct = total > 0 ? (totals.low / total) * 100 : 0

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500" style={{ fontFamily: "var(--font-display)" }}>
        FMV Health
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-zinc-900" />
      ) : total === 0 ? (
        <div className="mt-2 text-sm text-zinc-500">No FMV coverage yet.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>
            {fmt(totals.fmv)} <span className="text-[11px] text-zinc-500">reliable</span>
          </div>
          <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full border border-zinc-800">
            {highPct > 0 && (
              <div style={{ width: `${highPct}%`, background: "var(--rpc-success)" }} title={`High conf ${highPct.toFixed(0)}%`} />
            )}
            {lowPct > 0 && (
              <div style={{ width: `${lowPct}%`, background: "var(--rpc-warning)" }} title={`Low conf ${lowPct.toFixed(0)}%`} />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <span style={{ color: "var(--rpc-success)" }}>{totals.high.toLocaleString()} high</span>
            <span className="text-zinc-700">·</span>
            <span style={{ color: "var(--rpc-warning)" }}>{totals.low.toLocaleString()} low</span>
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-500">{totals.edition.toLocaleString()} editions</span>
          </div>
        </>
      )}
    </div>
  )
}

function PackEvCard({ short, urlSlug }: { short: string; urlSlug: string }) {
  const [data, setData] = useState<PacksSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/analytics/packs/summary?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setData(j as PacksSummaryResponse) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const stats = data?.collections?.[short]
  const tracked = Number(stats?.packs_tracked ?? 0)
  const positive = Number(stats?.positive_ev_packs ?? 0)
  const ratio = stats?.avg_value_ratio != null ? Number(stats.avg_value_ratio) : null

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500" style={{ fontFamily: "var(--font-display)" }}>
        Pack EV
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-zinc-900" />
      ) : !stats || tracked === 0 ? (
        <div className="mt-2 text-sm text-zinc-500">Pack analytics not yet available for this collection.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>
            {tracked.toLocaleString()} <span className="text-[11px] text-zinc-500">packs tracked</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Positive EV</div>
              <div style={{ color: positive > 0 ? "var(--rpc-success)" : "var(--rpc-text-muted)" }}>{positive.toLocaleString()}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Avg ratio</div>
              <div className="text-zinc-200">{ratio != null ? `${ratio.toFixed(2)}x` : "—"}</div>
            </div>
          </div>
          <Link
            href={`/${urlSlug}/packs`}
            className="mt-2 inline-flex items-center gap-1 text-[11px] uppercase tracking-widest"
            style={{ color: "var(--rpc-red)", fontFamily: "var(--font-display)" }}
          >
            View pack analytics <ArrowUpRight size={11} />
          </Link>
        </>
      )}
    </div>
  )
}

function LoansBookCard({ short }: { short: string }) {
  const [data, setData] = useState<ListingsSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    fetch(`/api/analytics/listings/summary?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j) setData(j as ListingsSummaryResponse) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const slot = data?.loan_offers?.collections?.[short]
  const count = Number(slot?.count ?? 0)
  const principal = Number(slot?.total_principal_usd ?? 0)
  const apr = data?.loan_offers?.avg_apr ?? null

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="text-[10px] uppercase tracking-widest text-zinc-500" style={{ fontFamily: "var(--font-display)" }}>
        Loans Book
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-zinc-900" />
      ) : count === 0 ? (
        <div className="mt-2 text-sm text-zinc-500">No active loan offers — Flowty book is concentrated on Top Shot.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>
            {count.toLocaleString()} <span className="text-[11px] text-zinc-500">offers</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Principal</div>
              <div className="text-zinc-200">{fmt(principal)}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-zinc-500">Avg APR</div>
              <div className="text-zinc-200">{apr != null ? `${(Number(apr) * 100).toFixed(1)}%` : "—"}</div>
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function WhaleLeaderboard({ short }: { short: string }) {
  const [buyers, setBuyers] = useState<LeaderboardRow[] | null>(null)
  const [sellers, setSellers] = useState<LeaderboardRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const qs = `collections=${encodeURIComponent(short)}&window=l30&min_volume=100&limit=10`
    Promise.all([
      fetch(`/api/analytics/sales/leaderboard?role=buyer&${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/analytics/sales/leaderboard?role=seller&${qs}`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([b, s]) => {
        if (cancelled) return
        setBuyers((b?.rows as LeaderboardRow[]) ?? [])
        setSellers((s?.rows as LeaderboardRow[]) ?? [])
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const Table = ({ title, rows }: { title: string; rows: LeaderboardRow[] | null }) => (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h3 className="mb-3 text-sm uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>{title}</h3>
      {loading && !rows ? (
        <div className="h-32 animate-pulse rounded bg-zinc-900" />
      ) : !rows || rows.length === 0 ? (
        <div className="py-4 text-center text-sm text-zinc-500">No data.</div>
      ) : (
        <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
          <thead>
            <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
              <th className="py-1.5 pr-2">#</th>
              <th className="py-1.5 pr-2">Wallet</th>
              <th className="py-1.5 pr-2 text-right">Sales</th>
              <th className="py-1.5 text-right">Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.rank}-${r.addr}`} className="border-b border-zinc-900">
                <td className="py-1.5 pr-2 text-zinc-500">{r.rank}</td>
                <td className="py-1.5 pr-2 text-zinc-200">
                  <Link
                    href={`/analytics/wallets/${encodeURIComponent(r.addr)}`}
                    className="hover:underline"
                    style={{ color: "var(--rpc-text-primary)" }}
                  >
                    {r.username || shortAddr(r.addr)}
                  </Link>
                </td>
                <td className="py-1.5 pr-2 text-right text-zinc-400">{r.sale_count.toLocaleString()}</td>
                <td className="py-1.5 text-right text-white">{fmt(r.total_volume_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )

  const isTs = short === "topshot"
  return (
    <section className="space-y-3">
      {isTs && (
        <div
          className="rounded-lg border px-3 py-2 text-[11px]"
          style={{
            border: "1px solid var(--rpc-red-border)",
            background: "var(--rpc-red-bg)",
            color: "var(--rpc-text-secondary)",
            fontFamily: "var(--font-mono)",
          }}
        >
          On-chain data only — Top Shot&apos;s centralized marketplace is ~94% of volume and doesn&apos;t expose wallet identities.{" "}
          <Link href="/analytics/sales" className="underline" style={{ color: "var(--rpc-red)" }}>
            View full sales breakdown at /analytics/sales
          </Link>.
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Table title="Top Buyers (30d)" rows={buyers} />
        <Table title="Top Sellers (30d)" rows={sellers} />
      </div>
    </section>
  )
}

// ── Portfolio-tab side cards ────────────────────────────────────────────────

function SalesHistoryCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch(`/api/wallet-sales-history?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}&limit=10`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => { if (!cancelled && j?.rows) setRows(j.rows) })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [wallet, urlSlug])
  if (missing || (rows && rows.length === 0)) return null
  if (!rows) return null
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
        Sales History
      </h2>
      <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
        <thead>
          <tr className="border-b border-zinc-800 text-left text-[10px] uppercase tracking-widest text-zinc-500">
            <th className="py-1.5 pr-2">Player</th>
            <th className="py-1.5 pr-2">Set</th>
            <th className="py-1.5 pr-2">Serial</th>
            <th className="py-1.5 pr-2 text-right">Price</th>
            <th className="py-1.5 pr-2">Marketplace</th>
            <th className="py-1.5 text-right">Date</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s, i) => (
            <tr key={i} className="border-b border-zinc-900">
              <td className="py-1.5 pr-2 text-zinc-200">{s.player_name ?? "—"}</td>
              <td className="py-1.5 pr-2 text-zinc-400">{s.set_name ?? "—"}</td>
              <td className="py-1.5 pr-2 text-zinc-400">{s.serial_number ? `#${s.serial_number}` : "—"}</td>
              <td className="py-1.5 pr-2 text-right text-white">{fmt(Number(s.price_usd) || 0)}</td>
              <td className="py-1.5 pr-2 text-zinc-300">{s.marketplace ?? "—"}</td>
              <td className="py-1.5 text-right text-zinc-500">{s.sold_at ? relativeDate(s.sold_at) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}

function CrossCollectionHoldingsCard({ usernameInput }: { usernameInput: string }) {
  const [bundle, setBundle] = useState<any | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    if (!usernameInput || usernameInput.startsWith("0x")) { setMissing(true); return }
    let cancelled = false
    fetch(`/api/public/profile/${encodeURIComponent(usernameInput.replace(/^@+/, ""))}`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => { if (!cancelled && j) setBundle(j) })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [usernameInput])
  if (missing || !bundle?.wallets) return null
  // Bucket wallets by collection_id, summing cached_moment_count.
  const buckets = new Map<string, number>()
  for (const w of bundle.wallets as Array<any>) {
    const cid = String(w.collection_id || "unknown")
    buckets.set(cid, (buckets.get(cid) ?? 0) + (Number(w.cached_moment_count) || 0))
  }
  if (buckets.size === 0) return null
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
        Cross-Collection Holdings
      </h2>
      <div className="flex flex-wrap gap-2">
        {Array.from(buckets.entries()).map(([cid, count]) => (
          <span
            key={cid}
            className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-[11px]"
            style={{ border: "1px solid var(--rpc-border)", background: "var(--rpc-surface)", fontFamily: "var(--font-mono)" }}
          >
            <span className="text-zinc-400">{cid.slice(0, 8)}</span>
            <span className="text-zinc-700">·</span>
            <span className="text-zinc-200">{count.toLocaleString()} moments</span>
          </span>
        ))}
      </div>
    </section>
  )
}

function HeldTimeDistributionCard({ wallet, urlSlug }: { wallet: string; urlSlug: string }) {
  const [data, setData] = useState<Array<{ bucket: string; count: number }> | null>(null)
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    let cancelled = false
    // Optimistic: try a hypothetical hold-time route that may not exist.
    fetch(`/api/wallet-hold-time?wallet=${encodeURIComponent(wallet)}&collection=${encodeURIComponent(urlSlug)}`)
      .then(async (r) => {
        if (!r.ok) { setMissing(true); return null }
        return r.json()
      })
      .then((j) => { if (!cancelled && j?.buckets) setData(j.buckets) })
      .catch(() => { setMissing(true) })
    return () => { cancelled = true }
  }, [wallet, urlSlug])
  if (missing || !data || data.length === 0) return null
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
        Held Time Distribution
      </h2>
      <div className="h-56" style={{ fontFamily: "var(--font-mono)" }}>
        <ResponsiveContainer>
          <BarChart data={data}>
            <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
            <XAxis dataKey="bucket" stroke="#71717a" tick={{ fontSize: 10 }} />
            <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
            <ReTooltip contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }} />
            <Bar dataKey="count" fill="var(--rpc-info)" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </section>
  )
}

// ── Main ────────────────────────────────────────────────────────────────────

function AnalyticsInner() {
  const params = useParams()
  const router = useRouter()
  const searchParams = useSearchParams()
  const collection = (params?.collection as string) || ""
  const short = shortSlug(collection)
  const urlWallet = searchParams.get("wallet") || ""
  const urlTab = (searchParams.get("tab") || "market").toLowerCase() === "portfolio" ? "portfolio" : "market"

  const [tab, setTab] = useState<"market" | "portfolio">(urlTab as "market" | "portfolio")

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
  const isPinnacle = collection === "disney-pinnacle"

  // Sync tab to URL.
  const switchTab = useCallback((next: "market" | "portfolio") => {
    setTab(next)
    const sp = new URLSearchParams(searchParams.toString())
    sp.set("tab", next)
    try { router.replace(`?${sp.toString()}`, { scroll: false }) } catch {}
  }, [router, searchParams])

  // Thin-volume notice from /api/ready.
  const [thinVolumeReady, setThinVolumeReady] = useState(false)
  useEffect(() => {
    if (!collection) return
    let cancelled = false
    fetch("/api/ready", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled || !j?.per_collection) return
        const row = (j.per_collection as Array<{ slug: string; sales_24h: number }>).find((r) => r.slug === collection)
        setThinVolumeReady(row != null && (row.sales_24h ?? 0) < 10)
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [collection])

  // Market analytics fetch (collection-wide; both tabs use this for chart data).
  useEffect(() => {
    if (!collection) return
    let cancelled = false
    setMarketLoading(true)
    fetch(`/api/market-analytics?collection=${encodeURIComponent(collection)}&period=30d&detail=full&comparison=true`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (!cancelled && j && !j.error) setMarketData(j as MarketAnalyticsResponse) })
      .catch(() => {})
      .finally(() => { if (!cancelled) setMarketLoading(false) })
    return () => { cancelled = true }
  }, [collection])

  const volumeByTier = useMemo(() => {
    if (!marketData?.tierAnalytics) return []
    return marketData.tierAnalytics
      .filter((t) => t.tier && t.tier !== "UNKNOWN" && Number(t.volume) > 0)
      .map((t) => ({ name: t.tier, value: Math.round(Number(t.volume) * 100) / 100 }))
  }, [marketData?.tierAnalytics])

  const marketplaceBreakdown = useMemo(() => {
    if (!marketData?.daily || marketData.daily.length === 0) return []
    const acc = new Map<string, { volume: number; transactions: number }>()
    for (const row of marketData.daily) {
      const mp = (row.marketplace || "unknown").toLowerCase()
      const slot = acc.get(mp) ?? { volume: 0, transactions: 0 }
      slot.volume += Number(row.volume ?? 0)
      slot.transactions += Number(row.saleCount ?? 0)
      acc.set(mp, slot)
    }
    return Array.from(acc.entries())
      .map(([marketplace, vals]) => ({
        marketplace,
        volume: Math.round(vals.volume * 100) / 100,
        transactions: vals.transactions,
      }))
      .filter((r) => r.volume > 0 || r.transactions > 0)
      .sort((a, b) => b.volume - a.volume)
  }, [marketData?.daily])

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

  const topSeriesKeys = useMemo(() => seriesVolumeBars.slice(0, 5).map((s) => s.name), [seriesVolumeBars])

  const dailySeriesPivot = useMemo(
    () => pivotDailySeries(marketData?.dailySeriesVolume, topSeriesKeys),
    [marketData?.dailySeriesVolume, topSeriesKeys]
  )

  // Debounced player search.
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
    try {
      const sp = new URLSearchParams(searchParams.toString())
      sp.set("wallet", trimmed)
      sp.set("tab", "portfolio")
      router.replace(`?${sp.toString()}`, { scroll: false })
    } catch {}
    try {
      const [analyticsRes, mpRes] = await Promise.all([
        fetch(`/api/analytics?wallet=${encodeURIComponent(trimmed)}&collection_id=${encodeURIComponent(collection)}`),
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
  }, [router, searchParams, collection])

  useEffect(() => {
    if (urlWallet && !data && !loading) runSearch(urlWallet)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlWallet])

  const acq = data?.acquisition ?? null
  const acqTotal = acq ? (acq.pack_pull_count + acq.marketplace_count + acq.challenge_reward_count + acq.gift_count) : 0
  const pctPack = acq && acqTotal > 0 ? (acq.pack_pull_count / acqTotal) * 100 : 0
  const pctMarket = acq && acqTotal > 0 ? (acq.marketplace_count / acqTotal) * 100 : 0
  const pctReward = acq && acqTotal > 0 ? (acq.challenge_reward_count / acqTotal) * 100 : 0
  const pctGift = acq && acqTotal > 0 ? (acq.gift_count / acqTotal) * 100 : 0
  const acquisitionNotIndexed = !acq || (acq.total_tracked ?? 0) === 0
  const seriesEmpty = !marketData?.seriesAnalytics || marketData.seriesAnalytics.length === 0
  const badgeEmpty = !marketData?.badgePremium || marketData.badgePremium.length === 0
  const hidePinnacleSeriesAndBadge = isPinnacle && seriesEmpty && badgeEmpty

  // Thin-volume mode (ecosystem-wide): both totalSales < 50 and the active period is 30d.
  const totalSales = marketData?.totals?.totalSales ?? 0
  const period = marketData?.period ?? "30d"
  const thinVolumeEcosystem = period === "30d" && totalSales < 50

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <HeaderChips short={short} />
      <TabNav active={tab} onChange={switchTab} />

      {thinVolumeReady && (
        <div
          className="mb-3 rounded border px-4 py-2 text-[11px] uppercase tracking-widest"
          style={{
            border: "1px solid var(--rpc-warning)",
            background: "rgba(245,158,11,0.08)",
            color: "var(--rpc-warning)",
            fontFamily: "var(--font-mono)",
          }}
        >
          Thin-volume ecosystem — analytics directional only.
        </div>
      )}

      {tab === "market" ? (
        <>
          {thinVolumeEcosystem && (
            <div
              className="mb-4 rounded-lg border px-4 py-3 text-[12px]"
              style={{
                border: "1px solid var(--rpc-border)",
                background: "var(--rpc-surface)",
                color: "var(--rpc-text-secondary)",
                fontFamily: "var(--font-mono)",
              }}
            >
              Thin-volume ecosystem — most metrics are directional only.{" "}
              <Link href="/analytics/sales" className="underline" style={{ color: "var(--rpc-red)" }}>
                View richer cross-collection data at /analytics/sales
              </Link>.
            </div>
          )}

          {/* 2x2 grid of new cards */}
          <section className="mb-6 grid grid-cols-1 gap-3 md:grid-cols-2">
            <OrderBookCard short={short} />
            <FmvHealthCard short={short} />
            <PackEvCard short={short} urlSlug={collection} />
            <LoansBookCard short={short} />
          </section>

          {/* Whale leaderboard */}
          <div className="mb-6">
            <WhaleLeaderboard short={short} />
          </div>

          {/* KPI strip */}
          {(() => {
            const pc = marketData?.periodComparison
            const cur = pc?.current
            const ch = pc?.changes
            const periodLabel = marketData?.period ?? "30d"
            const totalVolume = cur?.volume ?? marketData?.totals?.totalVolume ?? 0
            const totalSalesLocal = cur?.sales ?? marketData?.totals?.totalSales ?? 0
            const avgPrice = cur?.avgPrice ?? (totalSalesLocal > 0 ? totalVolume / totalSalesLocal : 0)
            const uniqueEds = cur?.uniqueEditions ?? 0
            return (
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Total Volume" value={fmt(totalVolume)} pct={pc ? ch?.volumePct : undefined} period={periodLabel} />
                <KpiCard label="Total Sales" value={totalSalesLocal.toLocaleString()} pct={pc ? ch?.salesPct : undefined} period={periodLabel} />
                <KpiCard label="Avg Sale Price" value={fmtUsd(avgPrice)} pct={pc ? ch?.avgPricePct : undefined} period={periodLabel} />
                <KpiCard label="Unique Editions" value={uniqueEds.toLocaleString()} pct={pc ? ch?.uniqueEditionsPct : undefined} period={periodLabel} />
              </div>
            )
          })()}

          <div className="space-y-6">
            <MarketplaceBreakdownCard rows={marketplaceBreakdown} loading={marketLoading && !marketData} period={marketData?.period ?? "30d"} />

            {/* Volume by Tier */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                Volume by Tier
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-zinc-900" />
              ) : volumeByTier.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-500">No data</div>
              ) : (
                <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
                  <ResponsiveContainer>
                    <PieChart>
                      <Pie data={volumeByTier} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={50} outerRadius={100} stroke="#18181b">
                        {volumeByTier.map((entry, i) => (
                          <Cell key={i} fill={TIER_HEX[entry.name] ?? "#6B7280"} />
                        ))}
                      </Pie>
                      <ReTooltip contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }} formatter={(v, n) => [fmtUsd(Number(v) || 0), String(n)]} />
                      <Legend formatter={(value: string, entry: any) => {
                        const v = entry?.payload?.value ?? 0
                        return <span style={{ color: "#e4e4e7" }}>{value} — {fmtUsd(v)}</span>
                      }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            {/* Top Sales */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                Top Sales
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-zinc-900" />
              ) : !marketData?.topSales || marketData.topSales.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-500">No data</div>
              ) : (
                <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
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

            {/* Hottest Editions */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                Hottest Editions
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-zinc-900" />
              ) : !marketData?.topEditions || marketData.topEditions.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-500">No data</div>
              ) : (
                <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
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

            {/* Average Price by Tier */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                Average Price by Tier
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-zinc-900" />
              ) : avgPricePivot.tiers.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-500">No data</div>
              ) : (
                <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
                  <ResponsiveContainer>
                    <LineChart data={avgPricePivot.data}>
                      <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                      <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                      <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString()}`} />
                      <ReTooltip contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }} formatter={(v, n) => [fmtUsd(Number(v) || 0), String(n)]} />
                      <Legend />
                      {avgPricePivot.tiers.map((t) => (
                        <Line key={t} type="monotone" dataKey={t} stroke={TIER_HEX[t] ?? "#6B7280"} strokeWidth={2} dot={false} connectNulls />
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            {/* Daily Sales by Tier */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                Daily Sales by Tier
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-zinc-900" />
              ) : saleCountPivot.tiers.length === 0 ? (
                <div className="py-8 text-center text-sm text-zinc-500">No data</div>
              ) : (
                <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
                  <ResponsiveContainer>
                    <AreaChart data={saleCountPivot.data}>
                      <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                      <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                      <YAxis stroke="#71717a" tick={{ fontSize: 10 }} />
                      <ReTooltip contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }} />
                      <Legend />
                      {saleCountPivot.tiers.map((t) => {
                        const hex = TIER_HEX[t] ?? "#6B7280"
                        return <Area key={t} type="monotone" dataKey={t} stackId="1" stroke={hex} fill={hex} fillOpacity={0.6} />
                      })}
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </section>

            {/* Badge Premium (hidden for Pinnacle when both empty) */}
            {!hidePinnacleSeriesAndBadge && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <h2 className="mb-1 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
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
                  <div className="flex flex-wrap gap-3" style={{ fontFamily: "var(--font-mono)" }}>
                    {marketData.badgePremium.map((b) => {
                      const tier = (b.tier ?? "").toUpperCase()
                      const dot = TIER_HEX[tier] ?? "#6B7280"
                      const pct = Number(b.premium_pct) || 0
                      const pctColor = pct >= 0 ? "var(--rpc-success)" : "var(--rpc-red)"
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
            )}

            {/* Volume by Series (hidden for Pinnacle when both empty) */}
            {!hidePinnacleSeriesAndBadge && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                  Volume by Series
                </h2>
                {marketLoading && !marketData ? (
                  <div className="h-64 animate-pulse rounded bg-zinc-900" />
                ) : seriesVolumeBars.length === 0 ? (
                  <div className="py-8 text-center text-sm text-zinc-500">No data</div>
                ) : (
                  <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
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
                          contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }}
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
            )}

            {/* Daily Volume by Series (hidden for Pinnacle when both empty) */}
            {!hidePinnacleSeriesAndBadge && (
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                  Daily Volume by Series
                </h2>
                {marketLoading && !marketData ? (
                  <div className="h-64 animate-pulse rounded bg-zinc-900" />
                ) : dailySeriesPivot.length === 0 ? (
                  <div className="py-8 text-center text-sm text-zinc-500">No data</div>
                ) : (
                  <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
                    <ResponsiveContainer>
                      <AreaChart data={dailySeriesPivot}>
                        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                        <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                        <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString()}`} />
                        <ReTooltip contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }} formatter={(v, n) => [fmtUsd(Number(v) || 0), String(n)]} />
                        <Legend />
                        {topSeriesKeys.map((s, i) => {
                          const color = SERIES_COLORS[i % SERIES_COLORS.length]
                          return <Area key={s} type="monotone" dataKey={s} stackId="1" stroke={color} fill={color} fillOpacity={0.6} />
                        })}
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </section>
            )}

            {/* Player Search */}
            <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-zinc-200" style={{ fontFamily: "var(--font-display)" }}>
                Player Search
              </h2>
              <input
                value={playerQuery}
                onChange={(e) => setPlayerQuery(e.target.value)}
                placeholder="Search by player name..."
                className="mb-3 w-full rounded-lg border border-zinc-800 bg-black px-4 py-2 text-white placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
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
                <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
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

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={exportCsv}
                disabled={!marketData?.daily?.length}
                className="rounded-lg border px-5 py-2 font-semibold uppercase tracking-widest text-white disabled:opacity-50"
                style={{
                  fontFamily: "var(--font-display)",
                  background: accent,
                  borderColor: accent,
                }}
              >
                Export CSV
              </button>
            </div>
          </div>
        </>
      ) : (
        <>
          {/* Portfolio tab */}
          <form
            onSubmit={(e) => { e.preventDefault(); runSearch(input) }}
            className="mb-6 flex flex-col gap-2 sm:flex-row"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Wallet address or username"
              className="flex-1 rounded-lg border border-zinc-800 bg-black px-4 py-2 text-white placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none"
              style={{ fontFamily: "var(--font-mono)" }}
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
              Enter a wallet address or {collectionMeta?.label || "collection"} username to see portfolio analytics.
            </div>
          )}

          {data && (
            <div className="space-y-6">
              {/* Portfolio Origin Story */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Portfolio Origin Story</div>
                {acquisitionNotIndexed ? (
                  <div className="rounded-lg border border-zinc-800 bg-black/30 px-3 py-3 text-[12px] text-zinc-400">
                    Acquisition history not yet indexed for this collection — coming soon.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500">Packs Pulled</div>
                        <div className="text-3xl font-black" style={{ color: "var(--tier-uncommon)", fontFamily: "var(--font-mono)" }}>{acq!.pack_pull_count.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500">Marketplace Buys</div>
                        <div className="text-3xl font-black text-zinc-300" style={{ fontFamily: "var(--font-mono)" }}>{acq!.marketplace_count.toLocaleString()}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-zinc-500">Challenge Rewards</div>
                        <div className="text-3xl font-black" style={{ color: "var(--rpc-warning)", fontFamily: "var(--font-mono)" }}>{acq!.challenge_reward_count.toLocaleString()}</div>
                      </div>
                    </div>
                    {acqTotal > 0 && (
                      <div className="mt-4">
                        <div className="flex h-3 w-full overflow-hidden rounded-full border border-zinc-800">
                          {pctPack > 0 && <div style={{ width: `${pctPack}%`, background: "var(--tier-uncommon)" }} />}
                          {pctMarket > 0 && <div style={{ width: `${pctMarket}%`, background: "rgb(161,161,170)" }} />}
                          {pctReward > 0 && <div style={{ width: `${pctReward}%`, background: "var(--rpc-warning)" }} />}
                          {pctGift > 0 && <div style={{ width: `${pctGift}%`, background: "var(--rpc-info)" }} />}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-zinc-500" style={{ fontFamily: "var(--font-mono)" }}>
                          <span>Pack {pctPack.toFixed(0)}%</span>
                          <span>Market {pctMarket.toFixed(0)}%</span>
                          <span>Reward {pctReward.toFixed(0)}%</span>
                          {pctGift > 0 && <span>Gift {pctGift.toFixed(0)}%</span>}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>

              {/* Liquid vs Locked */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Liquid vs Locked</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-zinc-800 bg-black p-3">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">Unlocked FMV</div>
                    <div className="text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>{fmt(data.locked.unlocked_fmv)}</div>
                    <div className="mt-1 text-[11px] text-zinc-500">{data.locked.unlocked_count.toLocaleString()} moments</div>
                  </div>
                  <div className="rounded-lg border border-zinc-800 bg-black p-3">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">Locked FMV</div>
                    <div className="text-2xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>{fmt(data.locked.locked_fmv)}</div>
                    <div className="mt-1 text-[11px] text-zinc-500">{data.locked.locked_count.toLocaleString()} moments</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-zinc-600">Locked moments cannot be listed or traded.</div>
              </section>

              {/* Marketplace Breakdown — TS vs Flowty */}
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
                      <div className="text-[11px] text-zinc-500" style={{ fontFamily: "var(--font-mono)" }}>Flowty {Number(flowtyPctSummary).toFixed(1)}%</div>
                    </div>
                    <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full border border-zinc-800">
                      {tsPct > 0 && <div style={{ width: `${tsPct}%`, background: "var(--rpc-red)" }} title={`Top Shot ${tsPct.toFixed(1)}%`} />}
                      {flPct > 0 && <div style={{ width: `${flPct}%`, background: "var(--tier-uncommon)" }} title={`Flowty ${flPct.toFixed(1)}%`} />}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-zinc-800 bg-black p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500">Top Shot</div>
                          <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold" style={{ color: "var(--rpc-red)", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.10)", fontFamily: "var(--font-mono)" }}>TS</span>
                        </div>
                        <div className="mt-1 text-xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>{(ts.count ?? 0).toLocaleString()}</div>
                        <div className="mt-1 text-[11px] text-zinc-500">purchases · {fmt(Number(ts.total_spent ?? 0))}</div>
                        <div className="mt-1 text-[11px] text-zinc-600">avg {fmt(Number(ts.avg_price ?? 0))}</div>
                      </div>
                      <div className="rounded-lg border border-zinc-800 bg-black p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500">Flowty</div>
                          <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold" style={{ color: "var(--tier-uncommon)", border: "1px solid rgba(20,184,166,0.35)", background: "rgba(20,184,166,0.10)", fontFamily: "var(--font-mono)" }}>Flowty</span>
                        </div>
                        <div className="mt-1 text-xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>{(fl.count ?? 0).toLocaleString()}</div>
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

              {/* Tier Breakdown */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 text-[11px] uppercase tracking-widest text-zinc-500">Tier Breakdown</div>
                <div className="space-y-2">
                  {data.tiers.map((t) => {
                    const maxFmv = data.tiers.reduce((m, x) => Math.max(m, x.fmv), 0)
                    const w = maxFmv > 0 ? (t.fmv / maxFmv) * 100 : 0
                    const color = TIER_COLOR[t.tier] ?? "var(--tier-common)"
                    return (
                      <div key={t.tier} className="flex items-center gap-3">
                        <div className="w-28 shrink-0 text-xs font-bold" style={{ color, fontFamily: "var(--font-mono)" }}>{t.tier}</div>
                        <div className="relative flex-1 h-5 rounded bg-zinc-900 overflow-hidden">
                          <div className="absolute inset-y-0 left-0" style={{ width: `${w}%`, background: color, opacity: 0.35 }} />
                          <div className="absolute inset-0 flex items-center px-2 text-[11px] text-zinc-300" style={{ fontFamily: "var(--font-mono)" }}>
                            {t.count.toLocaleString()} · {fmt(t.fmv)}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {data.tiers.length === 0 && <div className="text-sm text-zinc-500">No tier data.</div>}
                </div>
              </section>

              {/* Series Breakdown (hidden for Pinnacle when both empty) */}
              {!hidePinnacleSeriesAndBadge && (
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
                    <tbody style={{ fontFamily: "var(--font-mono)" }}>
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
              )}

              {/* Portfolio Clarity Score */}
              <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-widest text-zinc-500">
                  <span>Portfolio Clarity Score</span>
                  <span className="text-zinc-600" title="Share of moments with HIGH or MEDIUM FMV confidence. Higher = more reliable total portfolio FMV.">ⓘ</span>
                </div>
                <div className="text-5xl font-black text-white" style={{ fontFamily: "var(--font-mono)" }}>{data.portfolio_clarity_score.toFixed(1)}%</div>
                <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs" style={{ fontFamily: "var(--font-mono)" }}>
                  <div className="rounded border border-zinc-800 bg-black p-2">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">HIGH</div>
                    <div style={{ color: "var(--rpc-success)" }}>{(data.confidence.HIGH ?? 0).toLocaleString()}</div>
                  </div>
                  <div className="rounded border border-zinc-800 bg-black p-2">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">MEDIUM</div>
                    <div style={{ color: "var(--rpc-warning)" }}>{(data.confidence.MEDIUM ?? 0).toLocaleString()}</div>
                  </div>
                  <div className="rounded border border-zinc-800 bg-black p-2">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">LOW</div>
                    <div style={{ color: "var(--rpc-warning)", opacity: 0.8 }}>{(data.confidence.LOW ?? 0).toLocaleString()}</div>
                  </div>
                  <div className="rounded border border-zinc-800 bg-black p-2">
                    <div className="text-[10px] uppercase tracking-widest text-zinc-500">NO DATA</div>
                    <div className="text-zinc-500">{(data.confidence.NO_DATA ?? 0).toLocaleString()}</div>
                  </div>
                </div>
                <div className="mt-3 text-[11px] text-zinc-600">How reliably we know this portfolio&apos;s FMV. Higher means most moments have HIGH or MEDIUM confidence pricing.</div>
              </section>

              {/* Sales History (hidden silently if route doesn't exist) */}
              <SalesHistoryCard wallet={activeWallet} urlSlug={collection} />

              {/* Cross-Collection Holdings (only renders when input is a username) */}
              <CrossCollectionHoldingsCard usernameInput={input || urlWallet} />

              {/* Held Time Distribution (hidden silently if route doesn't exist) */}
              <HeldTimeDistributionCard wallet={activeWallet} urlSlug={collection} />
            </div>
          )}
        </>
      )}
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
