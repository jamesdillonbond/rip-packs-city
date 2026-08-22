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
import { MarketplaceStatusBanner } from "@/components/marketplace-status"
import { seriesLabel } from "@/lib/series-label"
import { pivotDailyTier, pivotDailySeries } from "@/lib/analytics-pivot"
import {
  buildVolumeByTier,
  aggregateMarketplaceDaily,
  buildSeriesVolumeBars,
  enrichMarketplaceRows,
  computeFmvHealth,
  computeAcquisitionBreakdown,
} from "@/lib/analytics/shape"
import { pickEmpty } from "@/lib/schonely"
import TopBuyers from "@/components/analytics/TopBuyers"
import HeldTimeDistributionCard from "@/components/analytics/HeldTimeDistributionCard"
import CostBasisCard from "@/components/analytics/CostBasisCard"
import SalesHistoryCard from "@/components/analytics/SalesHistoryCard"
import CrossCollectionHoldingsCard from "@/components/analytics/CrossCollectionHoldingsCard"
import { fmt, fmtUsd, shortAddr, relativeDate, shortSlug } from "@/lib/analytics/format"
import { hasRetiredOrderbookSource, TS_ORDERBOOK_RETIRED_LABEL, TS_ORDERBOOK_RETIRED_BODY } from "@/lib/analytics/ts-listings-retired"

// ── Slug mapping ────────────────────────────────────────────────────────────
// URL slug ("nba-top-shot") → RPC short slug ("topshot") used by the
// /api/analytics/* endpoints. Distinct from SLUG_TO_DB_SLUG (long form
// "nba_top_shot") which is what the sales/editions tables persist.
// URL_TO_SHORT_SLUG / shortSlug extracted to @/lib/analytics/format (imported above).

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

// Hex tier colors required by recharts SVG rendering — CSS vars can't be read
// from SVG attributes, so charts must use literal hex. Non-chart UI uses
// TIER_COLOR (var(--tier-*)) tokens.
const TIER_HEX: Record<string, string> = {
  ULTIMATE: "#FFD700",
  LEGENDARY: "#A855F7",
  RARE: "#3B82F6",
  FANDOM: "#22C55E",
  COMMON: "#6B7280",
}

const SERIES_COLORS = ["#14B8A6", "#A855F7", "#F59E0B", "#3B82F6", "#EF4444", "#22C55E", "#F472B6", "#EAB308", "#60A5FA"]

// MARKETPLACE_LABEL / MARKETPLACE_COLOR / marketplaceLabel / marketplaceColor
// extracted to @/lib/analytics/format (imported above). brand-exception: the
// color palette is consumed by recharts <Cell fill> (SVG attr, no CSS-var
// resolution); the non-red entries are deliberate per-marketplace hues.

// seriesLabel extracted to @/lib/series-label (imported below).

// pivotDailySeries extracted to @/lib/analytics-pivot (imported below).

// pivotDailyTier extracted to @/lib/analytics-pivot (imported below).

// ── Reusable atoms ──────────────────────────────────────────────────────────

function ChangeBadge({ pct }: { pct: number | null | undefined }) {
  if (pct == null || !Number.isFinite(pct) || pct === 0) {
    return <span className="text-[10px] text-[color:var(--rpc-text-muted)]">— 0%</span>
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
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">{props.label}</div>
      <div className="mt-1 text-2xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>{props.value}</div>
      <div className="mt-1 flex items-center gap-2">
        <ChangeBadge pct={props.pct} />
        <span className="text-[9px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">vs prev {props.period}</span>
      </div>
    </div>
  )
}

function HeaderChips({ short }: { short: string }) {
  const chips: Array<{ href: string; label: string }> = [
    { href: `/analytics/sales?collections=${short}`, label: "Sales" },
    { href: `/analytics/listings?collections=${short}`, label: "Listings" },
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
    <div className="mb-6 flex border-b border-[color:var(--rpc-border)]">
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
  const enriched = enrichMarketplaceRows(rows)

  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
        Marketplace Breakdown <span className="ml-1 text-[10px] tracking-widest text-[color:var(--rpc-text-muted)]">/ last {period}</span>
      </h2>
      {loading ? (
        <div className="h-48 animate-pulse rounded bg-[var(--rpc-surface)]" />
      ) : enriched.length === 0 ? (
        <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No marketplace activity in the last {period}.</div>
      ) : enriched.length === 1 ? (
        <div
          className="flex items-center justify-between gap-3 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)]/30 p-3"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          <div className="flex items-center gap-3">
            <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: enriched[0].color }} />
            <span className="text-sm font-semibold text-[color:var(--rpc-text-primary)]">{enriched[0].label}</span>
            <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">single source</span>
          </div>
          <div className="flex items-center gap-4 text-[11px] text-[color:var(--rpc-text-secondary)]">
            <span>Volume {fmt(enriched[0].volume)}</span>
            <span className="text-[color:var(--rpc-text-muted)]">·</span>
            <span>{enriched[0].transactions.toLocaleString("en-US")} sales</span>
            <span className="text-[color:var(--rpc-text-muted)]">·</span>
            <span style={{ color: enriched[0].color }} className="font-bold">100%</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <div className="h-72" style={{ fontFamily: "var(--font-mono)" }}>
            <div className="mb-1 text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">USD volume</div>
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
            <div className="mb-1 text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Transactions</div>
            <ResponsiveContainer>
              <BarChart data={enriched} margin={{ top: 10, right: 16, bottom: 30, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
                <XAxis dataKey="label" tick={{ fill: "#a1a1aa", fontSize: 10 }} interval={0} angle={-15} textAnchor="end" height={50} />
                <YAxis tick={{ fill: "#a1a1aa", fontSize: 10 }} tickFormatter={(v) => Number(v).toLocaleString("en-US")} />
                <ReTooltip
                  contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }}
                  formatter={(v) => [Number(v).toLocaleString("en-US"), "Sales"] as [string, string]}
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
        <div className="mt-3 flex flex-wrap gap-3 text-[11px] text-[color:var(--rpc-text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
          {enriched.map((r) => (
            <span key={r.marketplace} className="inline-flex items-center gap-2">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: r.color }} />
              <span className="text-[color:var(--rpc-text-primary)]">{r.label}</span>
              <span className="text-[color:var(--rpc-text-muted)]">{fmt(r.volume)}</span>
              <span className="text-[color:var(--rpc-text-muted)]">·</span>
              <span className="text-[color:var(--rpc-text-muted)]">{r.volumePct.toFixed(1)}% vol</span>
              <span className="text-[color:var(--rpc-text-muted)]">·</span>
              <span className="text-[color:var(--rpc-text-muted)]">{r.txPct.toFixed(1)}% tx</span>
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
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    fetch(`/api/analytics/listings/summary?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        // ⚠ A non-2xx (503 statement timeout under saturation) and a thrown
        // fetch both land with no data. Rendering that as the empty state makes
        // a positive claim about the MARKET out of OUR outage. Mirrors the
        // marketFailed pattern already used further down this file.
        if (j) setData(j as ListingsSummaryResponse)
        else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const orderbook = data?.topshot_orderbook
  // Audit 2026-05-20: marketplace_listings can arrive as {} (not []) from the
  // analytics_listings_summary RPC; guard the shape so .find never throws.
  const marketplaceListings = data?.marketplace_listings
  const fromMarket = Array.isArray(marketplaceListings)
    ? marketplaceListings.find((m) => (m.collection || "").toLowerCase() === short)
    : undefined
  // For Top Shot prefer the orderbook block (locked-aware); for others read from marketplace_listings.
  const isTs = short === "topshot"
  // Retired-source check is deliberately independent of the fetch outcome: a
  // SUCCESSFUL read of a dead table still must not render as depth (D12b).
  const retiredSource = hasRetiredOrderbookSource(short)
  const count = isTs ? (orderbook?.count ?? 0) : (fromMarket?.count ?? 0)
  const median = isTs ? (orderbook?.median_ask_usd ?? null) : (fromMarket?.median_ask_usd ?? null)
  const p90 = isTs ? (orderbook?.p90_ask_usd ?? null) : (fromMarket?.p90_ask_usd ?? null)

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]" style={{ fontFamily: "var(--font-display)" }}>
        Order Book Depth
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-[var(--rpc-surface)]" />
      ) : retiredSource ? (
        // ⚠ D12b. This branch comes BEFORE the failed/count tests on purpose.
        // For Top Shot the orderbook block is computed from `ts_listings`, a
        // sampler retired 2026-05-26 holding one row from 2026-05-15 — so the
        // read SUCCEEDING is not good news and its count is not a market fact.
        // Neither the failed copy (which would blame our own read) nor the zero
        // copy (false — Top Shot carries thousands of live asks) is true here.
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">
          <span className="font-semibold text-[color:var(--rpc-text-secondary)]">{TS_ORDERBOOK_RETIRED_LABEL}</span>{" "}
          {TS_ORDERBOOK_RETIRED_BODY}
        </div>
      ) : failed ? (
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">Couldn&apos;t load the order book.</div>
      ) : count === 0 ? (
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">No live listings.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>
            {count.toLocaleString("en-US")} <span className="text-[11px] text-[color:var(--rpc-text-muted)]">listings</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Median ask</div>
              <div className="text-[color:var(--rpc-text-primary)]">{median != null ? fmt(median) : "—"}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">P90 ask</div>
              <div className="text-[color:var(--rpc-text-primary)]">{p90 != null ? fmt(p90) : "—"}</div>
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
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    fetch(`/api/analytics/fmv/tier-pulse?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        // ⚠ A non-2xx (503 statement timeout under saturation) and a thrown
        // fetch both land with no data. Rendering that as the empty state makes
        // a positive claim about the MARKET out of OUR outage. Mirrors the
        // marketFailed pattern already used further down this file.
        if (j?.rows) setRows(j.rows as FmvTierRow[])
        else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const totals = useMemo(() => computeFmvHealth(rows), [rows])
  const total = totals.total
  const highPct = totals.highPct
  const lowPct = totals.lowPct

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]" style={{ fontFamily: "var(--font-display)" }}>
        FMV Health
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-[var(--rpc-surface)]" />
      ) : failed ? (
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">Couldn&apos;t load FMV health.</div>
      ) : total === 0 ? (
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">No FMV coverage yet.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>
            {fmt(totals.fmv)} <span className="text-[11px] text-[color:var(--rpc-text-muted)]">reliable</span>
          </div>
          <div className="mt-2 flex h-2.5 w-full overflow-hidden rounded-full border border-[color:var(--rpc-border)]">
            {highPct > 0 && (
              <div style={{ width: `${highPct}%`, background: "var(--rpc-success)" }} title={`High conf ${highPct.toFixed(0)}%`} />
            )}
            {lowPct > 0 && (
              <div style={{ width: `${lowPct}%`, background: "var(--rpc-warning)" }} title={`Low conf ${lowPct.toFixed(0)}%`} />
            )}
          </div>
          <div className="mt-2 flex flex-wrap gap-3 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <span style={{ color: "var(--rpc-success)" }}>{totals.high.toLocaleString("en-US")} high</span>
            <span className="text-[color:var(--rpc-text-muted)]">·</span>
            <span style={{ color: "var(--rpc-warning)" }}>{totals.low.toLocaleString("en-US")} low</span>
            <span className="text-[color:var(--rpc-text-muted)]">·</span>
            <span className="text-[color:var(--rpc-text-muted)]">{totals.edition.toLocaleString("en-US")} editions</span>
          </div>
        </>
      )}
    </div>
  )
}

function PackEvCard({ short, urlSlug }: { short: string; urlSlug: string }) {
  const [data, setData] = useState<PacksSummaryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    fetch(`/api/analytics/packs/summary?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        // ⚠ A non-2xx (503 statement timeout under saturation) and a thrown
        // fetch both land with no data. Rendering that as the empty state makes
        // a positive claim about the MARKET out of OUR outage. Mirrors the
        // marketFailed pattern already used further down this file.
        if (j) setData(j as PacksSummaryResponse)
        else setFailed(true)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const stats = data?.collections?.[short]
  const tracked = Number(stats?.packs_tracked ?? 0)
  const positive = Number(stats?.positive_ev_packs ?? 0)
  const ratio = stats?.avg_value_ratio != null ? Number(stats.avg_value_ratio) : null

  return (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]" style={{ fontFamily: "var(--font-display)" }}>
        Pack EV
      </div>
      {loading ? (
        <div className="mt-2 h-16 animate-pulse rounded bg-[var(--rpc-surface)]" />
      ) : failed ? (
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">Couldn&apos;t load pack analytics.</div>
      ) : !stats || tracked === 0 ? (
        <div className="mt-2 text-sm text-[color:var(--rpc-text-muted)]">Pack analytics not yet available for this collection.</div>
      ) : (
        <>
          <div className="mt-1 text-2xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>
            {tracked.toLocaleString("en-US")} <span className="text-[11px] text-[color:var(--rpc-text-muted)]">packs tracked</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]" style={{ fontFamily: "var(--font-mono)" }}>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Positive EV</div>
              <div style={{ color: positive > 0 ? "var(--rpc-success)" : "var(--rpc-text-muted)" }}>{positive.toLocaleString("en-US")}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Avg ratio</div>
              <div className="text-[color:var(--rpc-text-primary)]">{ratio != null ? `${ratio.toFixed(2)}x` : "—"}</div>
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

function LiquidityHeatmapCard({ short }: { short: string }) {
  type Row = {
    collection: string
    l5: number; l4: number; l3: number; l2: number; l1: number; l0: number
    cold: number; total: number; high_conf_total_fmv: number
  }
  const [row, setRow] = useState<Row | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    fetch(`/api/analytics/fmv/liquidity-distribution?collections=${encodeURIComponent(short)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        // ⚠ A non-2xx (503 statement timeout under saturation) and a thrown
        // fetch both land with no data. Rendering that as the empty state makes
        // a positive claim about the MARKET out of OUR outage. Mirrors the
        // marketFailed pattern already used further down this file.
        if (!j?.rows) { setFailed(true); return }
        const match = (j.rows as Row[]).find((r) => (r.collection || "").toLowerCase() === short)
        setRow(match ?? null)
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  // Buckets in chart order: L5 (deepest) → L1 → cold (no rating).
  const BUCKETS = [
    { key: "l5", label: "L5", color: "var(--rpc-success)", help: "Deep liquidity" },
    { key: "l4", label: "L4", color: "var(--rpc-info)", help: "Strong liquidity" },
    { key: "l3", label: "L3", color: "var(--rpc-warning)", help: "Moderate" },
    { key: "l2", label: "L2", color: "#fb923c", help: "Light" },
    { key: "l1", label: "L1", color: "var(--rpc-danger)", help: "Thin" },
    { key: "cold", label: "Cold", color: "#475569", help: "No liquidity rating" },
  ] as const

  const total = row ? Number(row.total) || 0 : 0
  const fmv = row ? Number(row.high_conf_total_fmv) || 0 : 0
  const tooThin = total > 0 && total < 10

  return (
    <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]" style={{ fontFamily: "var(--font-display)" }}>
          Liquidity Heatmap
        </div>
        {row && (
          <div className="text-[11px] text-[color:var(--rpc-text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
            {total.toLocaleString("en-US")} editions · {fmt(fmv)} reliable FMV
          </div>
        )}
      </div>

      {loading && !row ? (
        <div className="h-16 animate-pulse rounded bg-[var(--rpc-surface)]" />
      ) : failed ? (
        <div className="text-sm text-[color:var(--rpc-text-muted)]">Couldn&apos;t load the liquidity heatmap.</div>
      ) : !row ? (
        <div className="text-sm text-[color:var(--rpc-text-muted)]">No liquidity data for this collection.</div>
      ) : tooThin ? (
        <div className="text-[11px]" style={{ color: "var(--rpc-text-muted)", fontFamily: "var(--font-mono)" }}>
          Insufficient FMV coverage to chart liquidity.
        </div>
      ) : (
        <>
          {/* Stacked horizontal proportion bar */}
          <div className="flex h-3 w-full overflow-hidden rounded-full border border-[color:var(--rpc-border)]">
            {BUCKETS.map((b) => {
              const value = Number((row as any)[b.key]) || 0
              const pct = total > 0 ? (value / total) * 100 : 0
              if (pct === 0) return null
              return (
                <div
                  key={b.key}
                  style={{ width: `${pct}%`, background: b.color }}
                  title={`${b.label} · ${value.toLocaleString("en-US")} (${pct.toFixed(1)}%)`}
                />
              )
            })}
          </div>

          {/* Mini-grid: count + percentage per bucket */}
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-6" style={{ fontFamily: "var(--font-mono)" }}>
            {BUCKETS.map((b) => {
              const value = Number((row as any)[b.key]) || 0
              const pct = total > 0 ? (value / total) * 100 : 0
              return (
                <div key={b.key} className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="inline-block h-2 w-2 rounded-full" style={{ background: b.color }} />
                    <span className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">{b.label}</span>
                  </div>
                  <div className="mt-1 text-base font-bold text-[color:var(--rpc-text-primary)]">{value.toLocaleString("en-US")}</div>
                  <div className="text-[10px] text-[color:var(--rpc-text-muted)]">{pct.toFixed(1)}%</div>
                </div>
              )
            })}
          </div>
        </>
      )}
    </section>
  )
}

function WhaleLeaderboard({ short }: { short: string }) {
  const [buyers, setBuyers] = useState<LeaderboardRow[] | null>(null)
  const [sellers, setSellers] = useState<LeaderboardRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setFailed(false)
    const qs = `collections=${encodeURIComponent(short)}&window=l30&min_volume=100&limit=10`
    Promise.all([
      fetch(`/api/analytics/sales/leaderboard?role=buyer&${qs}`).then((r) => (r.ok ? r.json() : null)),
      fetch(`/api/analytics/sales/leaderboard?role=seller&${qs}`).then((r) => (r.ok ? r.json() : null)),
    ])
      .then(([b, s]) => {
        if (cancelled) return
        // ⚠ Both legs must succeed. `?? []` on a failed leg renders "No data." —
        // a claim that nobody traded, made out of a read we never completed.
        if (!b?.rows || !s?.rows) { setFailed(true); return }
        setBuyers(b.rows as LeaderboardRow[])
        setSellers(s.rows as LeaderboardRow[])
      })
      .catch(() => { if (!cancelled) setFailed(true) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [short])

  const Table = ({ title, rows }: { title: string; rows: LeaderboardRow[] | null }) => (
    <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
      <h3 className="mb-3 text-sm uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>{title}</h3>
      {loading && !rows ? (
        <div className="h-32 animate-pulse rounded bg-[var(--rpc-surface)]" />
      ) : failed ? (
        <div className="py-4 text-center text-sm text-[color:var(--rpc-text-muted)]">Couldn&apos;t load this leaderboard.</div>
      ) : !rows || rows.length === 0 ? (
        <div className="py-4 text-center text-sm text-[color:var(--rpc-text-muted)]">No data.</div>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
          <thead>
            <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
              <th className="py-1.5 pr-2">#</th>
              <th className="py-1.5 pr-2">Wallet</th>
              <th className="py-1.5 pr-2 text-right">Sales</th>
              <th className="py-1.5 text-right">Volume</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.rank}-${r.addr}`} className="border-b border-[color:var(--rpc-border)]">
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-muted)]">{r.rank}</td>
                <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">
                  <Link
                    href={`/analytics/wallets/${encodeURIComponent(r.addr)}`}
                    className="hover:underline"
                    style={{ color: "var(--rpc-text-primary)" }}
                  >
                    {r.username || shortAddr(r.addr)}
                  </Link>
                </td>
                <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]">{r.sale_count.toLocaleString("en-US")}</td>
                <td className="py-1.5 text-right text-[color:var(--rpc-text-primary)]">{fmt(r.total_volume_usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
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
  // deep-audit D12: the fetch below soft-failed to null and every KPI fell back
  // to `?? 0`, so a timed-out request rendered "$0.00 / 0 sales" for 30d — on a
  // collection doing 89,831 sales / $583k in that window. A failure must not be
  // presented as a measurement.
  const [marketFailed, setMarketFailed] = useState(false)
  const [playerQuery, setPlayerQuery] = useState("")
  const [playerResults, setPlayerResults] = useState<PlayerSearchRow[] | null>(null)
  const [playerLoading, setPlayerLoading] = useState(false)
  // Distinct from "no results": a failed search must not claim the player has no
  // marketplace activity. See the debounced-search effect below.
  const [playerFailed, setPlayerFailed] = useState(false)

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
    setMarketFailed(false)
    fetch(`/api/market-analytics?collection=${encodeURIComponent(collection)}&period=30d&detail=full&comparison=true`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return
        if (j && !j.error) setMarketData(j as MarketAnalyticsResponse)
        // A non-2xx (503 statement timeout under saturation) or an { error }
        // body both land here with no data — that is a failure, not a zero.
        else setMarketFailed(true)
      })
      .catch(() => { if (!cancelled) setMarketFailed(true) })
      .finally(() => { if (!cancelled) setMarketLoading(false) })
    return () => { cancelled = true }
  }, [collection])

  const volumeByTier = useMemo(() => buildVolumeByTier(marketData?.tierAnalytics), [marketData?.tierAnalytics])

  const marketplaceBreakdown = useMemo(() => aggregateMarketplaceDaily(marketData?.daily), [marketData?.daily])

  const avgPricePivot = useMemo(
    () => pivotDailyTier(marketData?.dailyTierVolume, "avg_price"),
    [marketData?.dailyTierVolume]
  )
  const saleCountPivot = useMemo(
    () => pivotDailyTier(marketData?.dailyTierVolume, "sale_count"),
    [marketData?.dailyTierVolume]
  )

  const seriesVolumeBars = useMemo(() => buildSeriesVolumeBars(marketData?.seriesAnalytics), [marketData?.seriesAnalytics])

  const topSeriesKeys = useMemo(() => seriesVolumeBars.slice(0, 5).map((s) => s.name), [seriesVolumeBars])

  const dailySeriesPivot = useMemo(
    () => pivotDailySeries(marketData?.dailySeriesVolume, topSeriesKeys),
    [marketData?.dailySeriesVolume, topSeriesKeys]
  )

  // Debounced player search.
  //
  // ⚠ TWO defects lived in the previous `catch { /* swallow */ }` shape, and the
  // second is the worse one:
  //
  //   1. A FAILED search rendered `pickEmpty()` — "Quiet on the court for now."
  //      — which is a claim that THIS PLAYER has no marketplace activity,
  //      manufactured out of our own outage.
  //   2. `setPlayerResults` was only ever called on `!q` or on `res.ok`, so a
  //      failed search LEFT THE PREVIOUS PLAYER'S ROWS ON SCREEN. Search
  //      "Lillard", get rows; search "Curry", have the fetch fail, and the table
  //      still showed Lillard's numbers with "Curry" in the input. That is worse
  //      than an empty state: it is one player's market data labelled as
  //      another's, with nothing on screen to suggest anything went wrong.
  //
  // So the results are cleared when a new query starts, and failure is tracked
  // separately from emptiness.
  useEffect(() => {
    const q = playerQuery.trim()
    setPlayerFailed(false)
    if (!q) { setPlayerResults(null); return }
    const timer = setTimeout(async () => {
      setPlayerLoading(true)
      // Drop the previous player's rows BEFORE the new request — they answer a
      // question the user is no longer asking.
      setPlayerResults(null)
      try {
        const res = await fetch(
          `/api/market-analytics?collection=${encodeURIComponent(collection)}&period=30d&detail=full&player=${encodeURIComponent(q)}`
        )
        if (res.ok) {
          const j = await res.json()
          setPlayerResults(j.playerSearch ?? [])
        } else {
          setPlayerFailed(true)
        }
      } catch { setPlayerFailed(true) }
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
  const { acqTotal, pctPack, pctMarket, pctReward, pctGift, acquisitionNotIndexed } =
    computeAcquisitionBreakdown(acq)
  const seriesEmpty = !marketData?.seriesAnalytics || marketData.seriesAnalytics.length === 0
  const badgeEmpty = !marketData?.badgePremium || marketData.badgePremium.length === 0
  const hidePinnacleSeriesAndBadge = isPinnacle && seriesEmpty && badgeEmpty

  // Thin-volume mode (ecosystem-wide): both totalSales < 50 and the active period is 30d.
  //
  // ⚠ MUST be gated on `!marketFailed`, and this is the SAME defect deep-audit
  // D12 fixed one derivation higher. `totalSales` falls back to 0 and `period`
  // to "30d" when the read failed, so without the gate a 503 renders
  // "Thin-volume ecosystem — most metrics are directional only." — a specific
  // claim about the MARKET manufactured from OUR outage, and an actionable one
  // (it tells a collector not to trust figures we simply failed to fetch).
  // D12 added `marketFailed` for the KPI band and this derived notice was never
  // gated on it: a page is not made honest by fixing the component that failed.
  const totalSales = marketData?.totals?.totalSales ?? 0
  const period = marketData?.period ?? "30d"
  const thinVolumeEcosystem = !marketFailed && marketData != null && period === "30d" && totalSales < 50

  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <HeaderChips short={short} />
      <TabNav active={tab} onChange={switchTab} />

      {/* Marketplace status banner — renders nothing for healthy collections.
          This tab is the densest FMV surface on the site (total_fmv, per-tier and
          per-series FMV, locked/unlocked split), so on a collection whose market
          has closed it values an entire portfolio on prices that stopped moving:
          UFC's last Flow sale was 2026-05-13, yet its snapshots keep re-stamping
          computed_at, so every freshness signal here reads green. The banner is
          the collection-level fact that a per-row staleness heuristic cannot
          supply. Mounted 2026-08-03 — analytics and sets were the two UFC tabs
          the 08-02 disclosure work never reached. */}
      <div className="mb-3">
        <MarketplaceStatusBanner collectionSlug={collection} />
      </div>

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
          </section>

          {/* Liquidity heatmap (full-width — needs the room for the 6-bucket mini-grid) */}
          <div className="mb-6">
            <LiquidityHeatmapCard short={short} />
          </div>

          {/* Whale leaderboard */}
          <div className="mb-6">
            <WhaleLeaderboard short={short} />
          </div>

          {/* Buyer-side accumulation — who is sweeping what. Top Shot only for
              now: it's the only collection with resolved buyer_address coverage
              (the 2026-06-09 buyer-resolution ship). */}
          {short === "topshot" && (
            <div className="mb-6">
              <TopBuyers collection="nba_top_shot" />
            </div>
          )}

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
            // Failed fetch => em-dash, not 0. Rendering 0 here told visitors the
            // Top Shot market had no sales in 30 days while the Overview tab on
            // the same collection showed $32,584 in 24h (deep-audit D12).
            const dash = "—"
            const kpi = (v: string) => (marketFailed && !marketData ? dash : v)
            return (
              <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <KpiCard label="Total Volume" value={kpi(fmt(totalVolume))} pct={pc ? ch?.volumePct : undefined} period={periodLabel} />
                <KpiCard label="Total Sales" value={kpi(totalSalesLocal.toLocaleString("en-US"))} pct={pc ? ch?.salesPct : undefined} period={periodLabel} />
                <KpiCard label="Avg Sale Price" value={kpi(fmtUsd(avgPrice))} pct={pc ? ch?.avgPricePct : undefined} period={periodLabel} />
                <KpiCard label="Unique Editions" value={kpi(uniqueEds.toLocaleString("en-US"))} pct={pc ? ch?.uniqueEditionsPct : undefined} period={periodLabel} />
              </div>
            )
          })()}

          <div className="space-y-6">
            <MarketplaceBreakdownCard rows={marketplaceBreakdown} loading={marketLoading && !marketData} period={marketData?.period ?? "30d"} />

            {/* Volume by Tier */}
            <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                Volume by Tier
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
              ) : volumeByTier.length === 0 ? (
                <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
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
            <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                Top Sales
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
              ) : !marketData?.topSales || marketData.topSales.length === 0 ? (
                <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
                  <thead>
                    <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
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
                        <tr key={i} className="border-b border-[color:var(--rpc-border)]">
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-muted)]">{i + 1}</td>
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">{s.player_name ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{s.set_name ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                              {tier || "—"}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]">
                            {s.serial_number ? `#${s.serial_number}${s.circulation_count ? `/${s.circulation_count}` : ""}` : "—"}
                          </td>
                          <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{fmtUsd(s.price_usd)}</td>
                          <td className="py-1.5 text-right text-[color:var(--rpc-text-muted)]">{relativeDate(s.sold_at)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              )}
            </section>

            {/* Hottest Editions */}
            <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                Hottest Editions
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
              ) : !marketData?.topEditions || marketData.topEditions.length === 0 ? (
                <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
                  <thead>
                    <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
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
                          <tr key={i} className="border-b border-[color:var(--rpc-border)]">
                            <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">{e.player_name ?? "—"}</td>
                            <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{e.set_name ?? "—"}</td>
                            <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">
                              <span className="inline-flex items-center gap-1.5">
                                <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                                {tier || "—"}
                              </span>
                            </td>
                            <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]">{Number(e.sale_count).toLocaleString("en-US")}</td>
                            <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{fmtUsd(e.volume)}</td>
                            <td className="py-1.5 text-right text-[color:var(--rpc-text-secondary)]">{fmtUsd(e.avg_price)}</td>
                          </tr>
                        )
                      })}
                  </tbody>
                </table>
                </div>
              )}
            </section>

            {/* Average Price by Tier */}
            <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                Average Price by Tier
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
              ) : avgPricePivot.tiers.length === 0 ? (
                <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
              ) : (
                <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
                  <ResponsiveContainer>
                    <LineChart data={avgPricePivot.data}>
                      <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                      <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                      <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString("en-US")}`} />
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
            <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                Daily Sales by Tier
              </h2>
              {marketLoading && !marketData ? (
                <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
              ) : saleCountPivot.tiers.length === 0 ? (
                <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
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
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <h2 className="mb-1 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                  Badge Premium
                </h2>
                <div className="mb-3 text-[11px] text-[color:var(--rpc-text-muted)]">
                  How much more badged editions sell for vs non-badged within the same tier
                </div>
                {marketLoading && !marketData ? (
                  <div className="h-40 animate-pulse rounded bg-[var(--rpc-surface)]" />
                ) : !marketData?.badgePremium || marketData.badgePremium.length === 0 ? (
                  <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
                ) : (
                  <div className="flex flex-wrap gap-3" style={{ fontFamily: "var(--font-mono)" }}>
                    {marketData.badgePremium.map((b) => {
                      const tier = (b.tier ?? "").toUpperCase()
                      const dot = TIER_HEX[tier] ?? "#6B7280"
                      const pct = Number(b.premium_pct) || 0
                      const pctColor = pct >= 0 ? "var(--rpc-success)" : "var(--rpc-red)"
                      return (
                        <div key={tier} className="flex-1 min-w-[180px] rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
                          <div className="flex items-center gap-1.5">
                            <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                            <span className="text-xs font-bold text-[color:var(--rpc-text-primary)]">{tier || "—"}</span>
                          </div>
                          <div className="mt-2 text-[11px] text-[color:var(--rpc-text-secondary)]">Badged Avg: <span className="text-[color:var(--rpc-text-primary)]">{fmtUsd(Number(b.badged_avg) || 0)}</span></div>
                          <div className="text-[11px] text-[color:var(--rpc-text-secondary)]">Non-Badged Avg: <span className="text-[color:var(--rpc-text-primary)]">{fmtUsd(Number(b.unbadged_avg) || 0)}</span></div>
                          <div className="mt-2 text-2xl font-black" style={{ color: pctColor }}>
                            {pct >= 0 ? "+" : ""}{pct.toFixed(0)}%
                          </div>
                          <div className="mt-1 text-[10px] text-[color:var(--rpc-text-muted)]">
                            {Number(b.badged_sales).toLocaleString("en-US")} badged / {Number(b.unbadged_sales).toLocaleString("en-US")} unbadged
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
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                  Volume by Series
                </h2>
                {marketLoading && !marketData ? (
                  <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
                ) : seriesVolumeBars.length === 0 ? (
                  <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
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
                        <XAxis type="number" stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString("en-US")}`} />
                        <YAxis type="category" dataKey="name" stroke="#71717a" tick={{ fontSize: 10 }} width={100} />
                        <ReTooltip
                          contentStyle={{ background: "#09090b", border: "1px solid #27272a", fontFamily: "var(--font-mono)" }}
                          formatter={(v, n, p: any) => {
                            const row = p?.payload ?? {}
                            return [
                              <span key="body">
                                {fmtUsd(Number(v) || 0)}
                                <div style={{ fontSize: 10, color: "#a1a1aa" }}>Avg {fmtUsd(row.avg_price || 0)} · {Number(row.sale_count).toLocaleString("en-US")} sales</div>
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
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                  Daily Volume by Series
                </h2>
                {marketLoading && !marketData ? (
                  <div className="h-64 animate-pulse rounded bg-[var(--rpc-surface)]" />
                ) : dailySeriesPivot.length === 0 ? (
                  <div className="py-8 text-center text-sm text-[color:var(--rpc-text-muted)]">No data</div>
                ) : (
                  <div className="h-72 w-full" style={{ fontFamily: "var(--font-mono)" }}>
                    <ResponsiveContainer>
                      <AreaChart data={dailySeriesPivot}>
                        <CartesianGrid stroke="#27272a" strokeDasharray="3 3" />
                        <XAxis dataKey="date" stroke="#71717a" tick={{ fontSize: 10 }} />
                        <YAxis stroke="#71717a" tick={{ fontSize: 10 }} tickFormatter={(v) => `$${Number(v).toLocaleString("en-US")}`} />
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
            <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
              <h2 className="mb-3 text-lg uppercase tracking-widest text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-display)" }}>
                Player Search
              </h2>
              <input
                value={playerQuery}
                onChange={(e) => setPlayerQuery(e.target.value)}
                placeholder="Search by player name..."
                className="mb-3 w-full rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] px-4 py-2 text-[color:var(--rpc-text-primary)] placeholder:text-[color:var(--rpc-text-muted)] focus:border-[color:var(--rpc-border-hover)] focus:outline-none"
                style={{ fontFamily: "var(--font-mono)" }}
              />
              {!playerQuery.trim() ? (
                <div className="py-6 text-center text-sm text-[color:var(--rpc-text-muted)]">
                  Search for a player to see their marketplace analytics
                </div>
              ) : playerLoading ? (
                <div className="h-24 animate-pulse rounded bg-[var(--rpc-surface)]" />
              ) : playerFailed ? (
                <div className="py-6 text-center text-sm text-[color:var(--rpc-text-muted)]">
                  Couldn&apos;t load player results. This says nothing about whether{" "}
                  {playerQuery.trim()} has marketplace activity — only that we couldn&apos;t
                  read it. Try again in a moment.
                </div>
              ) : !playerResults || playerResults.length === 0 ? (
                <div className="py-6 text-center text-sm text-[color:var(--rpc-text-muted)]">{pickEmpty()}</div>
              ) : (
                <div className="overflow-x-auto">
                <table className="w-full text-sm" style={{ fontFamily: "var(--font-mono)" }}>
                  <thead>
                    <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
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
                          className={`border-b border-[color:var(--rpc-border)] ${clickable ? "cursor-pointer hover:bg-[var(--rpc-surface)]/60" : ""}`}
                          onClick={() => {
                            if (!p.edition_key) return
                            window.open(`/api/edition-history?edition=${encodeURIComponent(p.edition_key)}&days=90`, "_blank")
                          }}
                        >
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-primary)]">{p.player_name ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{p.set_name ?? "—"}</td>
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">
                            <span className="inline-flex items-center gap-1.5">
                              <span className="inline-block h-2 w-2 rounded-full" style={{ background: dot }} />
                              {tier || "—"}
                            </span>
                          </td>
                          <td className="py-1.5 pr-2 text-[color:var(--rpc-text-secondary)]">{seriesLabel(p.series)}</td>
                          <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]">{Number(p.sale_count).toLocaleString("en-US")}</td>
                          <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-primary)]">{fmtUsd(p.volume)}</td>
                          <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-secondary)]">{fmtUsd(p.avg_price)}</td>
                          <td className="py-1.5 pr-2 text-right text-[color:var(--rpc-text-muted)]">{fmtUsd(p.min_price)}</td>
                          <td className="py-1.5 text-right text-[color:var(--rpc-text-secondary)]">{fmtUsd(p.max_price)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                </div>
              )}
            </section>

            <div className="flex justify-end pt-2">
              <button
                type="button"
                onClick={exportCsv}
                disabled={!marketData?.daily?.length}
                className="rounded-lg border px-5 py-2 font-semibold uppercase tracking-widest text-[color:var(--rpc-text-primary)] disabled:opacity-50"
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
              className="flex-1 rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] px-4 py-2 text-[color:var(--rpc-text-primary)] placeholder:text-[color:var(--rpc-text-muted)] focus:border-[color:var(--rpc-border-hover)] focus:outline-none"
              style={{ fontFamily: "var(--font-mono)" }}
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-lg border border-[color:var(--rpc-border-hover)] bg-[var(--rpc-surface)] px-5 py-2 font-semibold text-[color:var(--rpc-text-primary)] hover:bg-[var(--rpc-surface-raised)] disabled:opacity-50"
            >
              {loading ? "Analyzing..." : "Analyze"}
            </button>
          </form>

          {error && <div className="mb-4 rounded-lg border border-red-900/40 bg-red-950/20 p-3 text-sm text-red-300">{error}</div>}

          {!data && !loading && !error && (
            <div className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-8 text-center text-[color:var(--rpc-text-muted)]">
              Enter a wallet address or {collectionMeta?.label || "collection"} username to see portfolio analytics.
            </div>
          )}

          {data && (
            <div className="space-y-6">
              {/* Portfolio Origin Story */}
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <div className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Portfolio Origin Story</div>
                {acquisitionNotIndexed ? (
                  <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)]/30 px-3 py-3 text-[12px] text-[color:var(--rpc-text-secondary)]">
                    Acquisition history not yet indexed for this collection — coming soon.
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Packs Pulled</div>
                        <div className="text-3xl font-black" style={{ color: "var(--tier-uncommon)", fontFamily: "var(--font-mono)" }}>{acq!.pack_pull_count.toLocaleString("en-US")}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Marketplace Buys</div>
                        <div className="text-3xl font-black text-[color:var(--rpc-text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>{acq!.marketplace_count.toLocaleString("en-US")}</div>
                      </div>
                      <div>
                        <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Challenge Rewards</div>
                        <div className="text-3xl font-black" style={{ color: "var(--rpc-warning)", fontFamily: "var(--font-mono)" }}>{acq!.challenge_reward_count.toLocaleString("en-US")}</div>
                      </div>
                    </div>
                    {acqTotal > 0 && (
                      <div className="mt-4">
                        <div className="flex h-3 w-full overflow-hidden rounded-full border border-[color:var(--rpc-border)]">
                          {pctPack > 0 && <div style={{ width: `${pctPack}%`, background: "var(--tier-uncommon)" }} />}
                          {pctMarket > 0 && <div style={{ width: `${pctMarket}%`, background: "rgb(161,161,170)" }} />}
                          {pctReward > 0 && <div style={{ width: `${pctReward}%`, background: "var(--rpc-warning)" }} />}
                          {pctGift > 0 && <div style={{ width: `${pctGift}%`, background: "var(--rpc-info)" }} />}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-[color:var(--rpc-text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>
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
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <div className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Liquid vs Locked</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
                    <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Unlocked FMV</div>
                    <div className="text-2xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(data.locked.unlocked_fmv)}</div>
                    <div className="mt-1 text-[11px] text-[color:var(--rpc-text-muted)]">{data.locked.unlocked_count.toLocaleString("en-US")} moments</div>
                  </div>
                  <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
                    <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Locked FMV</div>
                    <div className="text-2xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>{fmt(data.locked.locked_fmv)}</div>
                    <div className="mt-1 text-[11px] text-[color:var(--rpc-text-muted)]">{data.locked.locked_count.toLocaleString("en-US")} moments</div>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-[color:var(--rpc-text-muted)]">Locked moments cannot be listed or traded.</div>
              </section>

              {/* Cost Basis & P&L (TopShot only; hides on non-TS or empty cost-basis) */}
              <CostBasisCard wallet={activeWallet} urlSlug={collection} />

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
                  <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Marketplace Breakdown</div>
                      <div className="text-[11px] text-[color:var(--rpc-text-muted)]" style={{ fontFamily: "var(--font-mono)" }}>Flowty {Number(flowtyPctSummary).toFixed(1)}%</div>
                    </div>
                    <div className="mb-3 flex h-3 w-full overflow-hidden rounded-full border border-[color:var(--rpc-border)]">
                      {tsPct > 0 && <div style={{ width: `${tsPct}%`, background: "var(--rpc-red)" }} title={`Top Shot ${tsPct.toFixed(1)}%`} />}
                      {flPct > 0 && <div style={{ width: `${flPct}%`, background: "var(--tier-uncommon)" }} title={`Flowty ${flPct.toFixed(1)}%`} />}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Top Shot</div>
                          <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold" style={{ color: "var(--rpc-red)", border: "1px solid rgba(239,68,68,0.35)", background: "rgba(239,68,68,0.10)", fontFamily: "var(--font-mono)" }}>TS</span>
                        </div>
                        <div className="mt-1 text-xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>{(ts.count ?? 0).toLocaleString("en-US")}</div>
                        <div className="mt-1 text-[11px] text-[color:var(--rpc-text-muted)]">purchases · {fmt(Number(ts.total_spent ?? 0))}</div>
                        <div className="mt-1 text-[11px] text-[color:var(--rpc-text-muted)]">avg {fmt(Number(ts.avg_price ?? 0))}</div>
                      </div>
                      <div className="rounded-lg border border-[color:var(--rpc-border)] bg-[var(--rpc-black)] p-3">
                        <div className="flex items-center justify-between">
                          <div className="text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Flowty</div>
                          <span className="rounded px-1.5 py-0.5 text-[9px] font-semibold" style={{ color: "var(--tier-uncommon)", border: "1px solid rgba(20,184,166,0.35)", background: "rgba(20,184,166,0.10)", fontFamily: "var(--font-mono)" }}>Flowty</span>
                        </div>
                        <div className="mt-1 text-xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>{(fl.count ?? 0).toLocaleString("en-US")}</div>
                        <div className="mt-1 text-[11px] text-[color:var(--rpc-text-muted)]">purchases · {fmt(Number(fl.total_spent ?? 0))}</div>
                        <div className="mt-1 text-[11px] text-[color:var(--rpc-text-muted)]">avg {fmt(Number(fl.avg_price ?? 0))}</div>
                      </div>
                    </div>
                    <div className="mt-3 text-[11px] text-[color:var(--rpc-text-muted)]">
                      Avg price gap:{" "}
                      {ts.avg_price > 0 && fl.avg_price > 0
                        ? `${fmt(Math.abs(Number(fl.avg_price) - Number(ts.avg_price)))} ${Number(fl.avg_price) > Number(ts.avg_price) ? "higher on Flowty" : "higher on Top Shot"}`
                        : "—"}
                    </div>
                  </section>
                )
              })()}

              {/* Tier Breakdown */}
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <div className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Tier Breakdown</div>
                <div className="space-y-2">
                  {data.tiers.map((t) => {
                    const maxFmv = data.tiers.reduce((m, x) => Math.max(m, x.fmv), 0)
                    const w = maxFmv > 0 ? (t.fmv / maxFmv) * 100 : 0
                    const color = TIER_COLOR[t.tier] ?? "var(--tier-common)"
                    return (
                      <div key={t.tier} className="flex items-center gap-3">
                        <div className="w-28 shrink-0 text-xs font-bold" style={{ color, fontFamily: "var(--font-mono)" }}>{t.tier}</div>
                        <div className="relative flex-1 h-5 rounded bg-[var(--rpc-surface)] overflow-hidden">
                          <div className="absolute inset-y-0 left-0" style={{ width: `${w}%`, background: color, opacity: 0.35 }} />
                          <div className="absolute inset-0 flex items-center px-2 text-[11px] text-[color:var(--rpc-text-secondary)]" style={{ fontFamily: "var(--font-mono)" }}>
                            {t.count.toLocaleString("en-US")} · {fmt(t.fmv)}
                          </div>
                        </div>
                      </div>
                    )
                  })}
                  {data.tiers.length === 0 && <div className="text-sm text-[color:var(--rpc-text-muted)]">No tier data.</div>}
                </div>
              </section>

              {/* Series Breakdown (hidden for Pinnacle when both empty) */}
              {!hidePinnacleSeriesAndBadge && (
                <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                  <div className="mb-3 text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">Series Breakdown</div>
                  <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-[color:var(--rpc-border)] text-left text-[10px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
                        <th className="pb-2">Series</th>
                        <th className="pb-2 text-right">Moments</th>
                        <th className="pb-2 text-right">Total FMV</th>
                      </tr>
                    </thead>
                    <tbody style={{ fontFamily: "var(--font-mono)" }}>
                      {data.series.map((s) => (
                        <tr key={s.label} className="border-b border-[color:var(--rpc-border)]">
                          <td className="py-1.5 text-[color:var(--rpc-text-secondary)]">{s.label}</td>
                          <td className="py-1.5 text-right text-[color:var(--rpc-text-secondary)]">{s.count.toLocaleString("en-US")}</td>
                          <td className="py-1.5 text-right text-[color:var(--rpc-text-primary)]">{fmt(s.fmv)}</td>
                        </tr>
                      ))}
                      {data.series.length === 0 && (
                        <tr><td colSpan={3} className="py-3 text-center text-[color:var(--rpc-text-muted)]">No series data.</td></tr>
                      )}
                    </tbody>
                  </table>
                  </div>
                </section>
              )}

              {/* Portfolio Clarity Score — confidence-tier breakdown removed
                  2026-07-11 (build-time signal); the score stays as a single
                  data-coverage metric. */}
              <section className="rounded-xl border border-[color:var(--rpc-border)] bg-[var(--rpc-surface)] p-4">
                <div className="mb-3 flex items-center gap-2 text-[11px] uppercase tracking-widest text-[color:var(--rpc-text-muted)]">
                  <span>Portfolio Clarity Score</span>
                  <span className="text-[color:var(--rpc-text-muted)]" title="Share of moments priced from solid recent sales data. Higher = more reliable total portfolio FMV.">ⓘ</span>
                </div>
                <div className="text-5xl font-black text-[color:var(--rpc-text-primary)]" style={{ fontFamily: "var(--font-mono)" }}>{data.portfolio_clarity_score.toFixed(1)}%</div>
                <div className="mt-3 text-[11px] text-[color:var(--rpc-text-muted)]">How reliably we know this portfolio&apos;s FMV. Higher means most moments are priced from solid recent sales data.</div>
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

export default function CollectionAnalyticsClient() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-6 text-[color:var(--rpc-text-muted)]">Loading…</div>}>
      <AnalyticsInner />
    </Suspense>
  )
}
