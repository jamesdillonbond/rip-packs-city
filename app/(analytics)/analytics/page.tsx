import type { Metadata } from "next"
import Link from "next/link"
import {
  Activity,
  BarChart3,
  List,
  HandCoins,
  Users,
  Package,
  Layers,
  Sparkles,
  ArrowUpRight,
} from "lucide-react"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"
import { supabaseAdmin } from "@/lib/supabase"
import PipelineHealthBadge from "@/components/analytics/PipelineHealthBadge"
import InsiderSignals from "@/components/analytics/InsiderSignals"
import RecentWhaleTrades from "@/components/analytics/RecentWhaleTrades"

// The dashboard fans out to several Supabase-backed APIs at render time
// and intermittently exceeds the 60s static-generation budget. Marking it
// dynamic keeps the build deterministic; ISR-style revalidation keeps
// repeat hits fast at the edge.
export const dynamic = "force-dynamic"
export const revalidate = 600

export const metadata: Metadata = analyticsMetadata({
  title: "Analytics — On-chain Intelligence for Flow Collectibles",
  description:
    "Comprehensive on-chain analytics across Flow's largest digital collectibles platforms — Top Shot, NFL All Day, Golazos, and Pinnacle. Live loan books, sales, listings, wallets, and FMV indices.",
  path: "/analytics",
})

interface LoansSummaryResponse {
  total_loans: number
  total_principal_usd: number
  unique_lenders: number
  unique_borrowers: number
  active_loans_count: number
}

interface SalesSummaryResponse {
  total_sales: number
  total_volume_usd: number
  unique_buyers: number
  unique_sellers: number
}

interface Pulse24hResponse {
  loans: { originations: number; origination_volume_usd: number }
  sales: { sales: number; volume_usd: number }
}

interface ListingsSummaryCardResponse {
  loan_offers: { count: number; total_principal_usd: number }
}

interface FmvHealthCardResponse {
  collections: Record<
    string,
    {
      editions_total: number
      reliable_total_fmv_usd: number
    }
  >
}

interface SetsSummaryCardResponse {
  collections: Record<
    string,
    {
      set_count: number
      edition_count: number
    }
  >
}

interface WalletsOverviewCardResponse {
  totals: {
    wallets_total: number
    last_active_within_7d: number
  }
}

async function loadLoansSummary(): Promise<LoansSummaryResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/loans/summary?window=all`, {
      next: { revalidate: 600 },
    })
    if (!res.ok) return null
    return (await res.json()) as LoansSummaryResponse
  } catch {
    return null
  }
}

async function loadSalesSummary(): Promise<SalesSummaryResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/sales/summary?window=l30`, {
      next: { revalidate: 600 },
    })
    if (!res.ok) return null
    return (await res.json()) as SalesSummaryResponse
  } catch {
    return null
  }
}

async function loadPulse24h(): Promise<Pulse24hResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/pulse/24h`, {
      next: { revalidate: 60 },
    })
    if (!res.ok) return null
    return (await res.json()) as Pulse24hResponse
  } catch {
    return null
  }
}

async function loadListingsSummary(): Promise<ListingsSummaryCardResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/listings/summary`, {
      next: { revalidate: 300 },
    })
    if (!res.ok) return null
    return (await res.json()) as ListingsSummaryCardResponse
  } catch {
    return null
  }
}

async function loadFmvHealth(): Promise<FmvHealthCardResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/fmv/health`, {
      next: { revalidate: 600 },
    })
    if (!res.ok) return null
    return (await res.json()) as FmvHealthCardResponse
  } catch {
    return null
  }
}

async function loadWalletsOverview(): Promise<WalletsOverviewCardResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/wallets/overview`, {
      next: { revalidate: 600 },
    })
    if (!res.ok) return null
    return (await res.json()) as WalletsOverviewCardResponse
  } catch {
    return null
  }
}

async function loadSetsSummary(): Promise<SetsSummaryCardResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/sets/summary`, {
      next: { revalidate: 600 },
    })
    if (!res.ok) return null
    return (await res.json()) as SetsSummaryCardResponse
  } catch {
    return null
  }
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "$0"
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

function formatCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return n.toString()
}

interface SectionCard {
  href: string
  label: string
  description: string
  icon: typeof Activity
  metrics?: Array<{ label: string; value: string }>
  status: "live"
  methodologyTopic?: string
}

const TIMELINE = [
  {
    date: "May 7, 2026",
    title: "Per-collection Market and Portfolio analytics tabs shipped",
  },
  {
    date: "May 7, 2026",
    title: "Pack analytics live across Top Shot and All Day with EV teasers per collection",
  },
  {
    date: "May 7, 2026",
    title: "FMV index extended to all five collections",
  },
  {
    date: "Mar 24, 2026",
    title: "Flowty marketplace reopened with USDCf loans",
  },
  {
    date: "Jan 30, 2026",
    title: "Limbo Loans repayment window closed",
  },
  {
    date: "Dec 30, 2025",
    title: "Flow exploit pause begins",
  },
  {
    date: "Sep 4, 2024",
    title: "Crescendo upgrade and USDCf launch",
  },
]

export default async function AnalyticsOverviewPage() {
  const [
    summary,
    salesSummary,
    pulse,
    listings,
    fmvHealth,
    walletsOverview,
    setsSummary,
  ] = await Promise.all([
    loadLoansSummary(),
    loadSalesSummary(),
    loadPulse24h(),
    loadListingsSummary(),
    loadFmvHealth(),
    loadWalletsOverview(),
    loadSetsSummary(),
  ])

  let fmvTotalUsd = 0
  let fmvEditionTotal = 0
  if (fmvHealth?.collections) {
    for (const stats of Object.values(fmvHealth.collections)) {
      fmvTotalUsd += stats?.reliable_total_fmv_usd ?? 0
      fmvEditionTotal += stats?.editions_total ?? 0
    }
  }

  let setsTotalSets = 0
  let setsTotalEditions = 0
  if (setsSummary?.collections) {
    for (const stats of Object.values(setsSummary.collections)) {
      setsTotalSets += stats?.set_count ?? 0
      setsTotalEditions += stats?.edition_count ?? 0
    }
  }

  const cards: SectionCard[] = [
    {
      href: "/analytics/loans",
      label: "Loans",
      description: "Live Flowty loan book — capital deployed, rates, default tracking.",
      icon: HandCoins,
      status: "live",
      methodologyTopic: "loans",
      metrics: summary
        ? [
            { label: "Total volume", value: formatUsd(summary.total_principal_usd) },
            { label: "Active loans", value: formatCount(summary.active_loans_count) },
          ]
        : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/pulse",
      label: "Pulse",
      description: "Live transaction stream — loans + sales across the Flow ecosystem, refreshing every 30s.",
      icon: Activity,
      status: "live",
      methodologyTopic: "pulse",
      metrics: pulse
        ? [
            {
              label: "24h sales",
              value: `${formatCount(pulse.sales?.sales ?? 0)} · ${formatUsd(pulse.sales?.volume_usd ?? 0)}`,
            },
            {
              label: "24h loans",
              value: `${formatCount(pulse.loans?.originations ?? 0)} · ${formatUsd(pulse.loans?.origination_volume_usd ?? 0)}`,
            },
          ]
        : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/sales",
      label: "Sales",
      description: "On-chain sales indexed across NFTStorefrontV2, TopShotMarketV3, and Pinnacle.Trade.",
      icon: BarChart3,
      status: "live",
      methodologyTopic: "sales",
      metrics: salesSummary
        ? [
            { label: "L30 volume", value: formatUsd(salesSummary.total_volume_usd) },
            { label: "L30 sales", value: formatCount(salesSummary.total_sales) },
          ]
        : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/listings",
      label: "Listings",
      description: "Open Flowty loan offers and a sample of the Top Shot orderbook.",
      icon: List,
      status: "live",
      methodologyTopic: "listings",
      metrics: listings
        ? [
            { label: "Open offers", value: formatCount(listings.loan_offers?.count ?? 0) },
            { label: "Liquidity", value: formatUsd(listings.loan_offers?.total_principal_usd ?? 0) },
          ]
        : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/wallets",
      label: "Wallets",
      description: "Every wallet active on the Flowty loan book — lenders, borrowers, and mixed-role power users.",
      icon: Users,
      status: "live",
      methodologyTopic: "wallet-profiles",
      metrics: walletsOverview?.totals
        ? [
            {
              label: "Total wallets",
              value: formatCount(walletsOverview.totals.wallets_total ?? 0),
            },
            {
              label: "Active 7d",
              value: formatCount(walletsOverview.totals.last_active_within_7d ?? 0),
            },
          ]
        : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/fmv",
      label: "FMV Index",
      description: "Algorithmic fair-market-value pricing across NBA Top Shot and NFL All Day editions.",
      icon: Sparkles,
      status: "live",
      methodologyTopic: "fmv",
      metrics:
        fmvTotalUsd > 0
          ? [
              { label: "Reliable FMV", value: formatUsd(fmvTotalUsd) },
              { label: "Editions", value: formatCount(fmvEditionTotal) },
            ]
          : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/packs",
      label: "Packs",
      description: "Pack listings ranked by expected value vs current ask, with FMV coverage and supply signals.",
      icon: Package,
      status: "live",
      methodologyTopic: "packs",
    },
    {
      href: "/analytics/sets",
      label: "Sets",
      description: "Catalog rollups across NBA Top Shot, NFL All Day, LaLiga Golazos, and UFC Strike — sets, editions, and series eras.",
      icon: Layers,
      status: "live",
      methodologyTopic: "sets",
      metrics:
        setsTotalSets > 0
          ? [
              { label: "Total sets", value: formatCount(setsTotalSets) },
              { label: "Editions", value: formatCount(setsTotalEditions) },
            ]
          : [{ label: "Status", value: "Live" }],
    },
  ]

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="rounded-xl border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 px-6 py-8 sm:px-8 sm:py-10">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-2 font-semibold">
              Rip Packs City Analytics
            </div>
            <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-50 mb-3">
              Analytics
            </h1>
            <p className="text-zinc-300 max-w-2xl leading-relaxed">
              Comprehensive on-chain analytics across Flow&apos;s largest digital collectibles
              platforms. Loan books, sales, listings, wallet cohorts, and FMV indices —
              updated continuously from chain events.
            </p>
          </div>
          <PipelineHealthBadge />
        </div>
      </section>

      {/* Insider signals — self-gating, renders only when has_data is true */}
      <InsiderSignals />

      {/* Section grid */}
      <section>
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">Sections</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => {
            const Icon = c.icon
            return (
              <div
                key={c.href}
                className="group relative rounded-xl border border-zinc-800 bg-zinc-900/40 p-5 transition-all hover:border-emerald-500/40 hover:bg-zinc-900/70"
              >
                <Link href={c.href} className="block">
                  <div className="flex items-start gap-3 mb-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-md border bg-emerald-500/10 border-emerald-500/20">
                      <Icon size={16} className="text-emerald-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-zinc-100">{c.label}</h3>
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-emerald-400 border border-emerald-500/30">
                          Live
                        </span>
                      </div>
                    </div>
                    <ArrowUpRight
                      size={14}
                      className="text-zinc-600 group-hover:text-emerald-400 transition-colors"
                    />
                  </div>
                  <p className="text-sm leading-relaxed mb-3 text-zinc-400">
                    {c.description}
                  </p>
                  {c.metrics ? (
                    <div className="flex gap-4 pt-3 border-t border-zinc-800/80">
                      {c.metrics.map((m) => (
                        <div key={m.label}>
                          <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                            {m.label}
                          </div>
                          <div className="text-base font-semibold tabular-nums text-zinc-100">
                            {m.value}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </Link>
                {c.methodologyTopic ? (
                  <Link
                    href={`/analytics/methodology/${c.methodologyTopic}`}
                    className="mt-3 inline-block text-[11px] uppercase tracking-widest text-zinc-500 hover:text-emerald-300 transition-colors"
                  >
                    Methodology →
                  </Link>
                ) : null}
              </div>
            )
          })}
        </div>
      </section>

      {/* Recent whale trades — top sales over the last 30 days */}
      <RecentWhaleTrades />

      {/* Recent updates timeline */}
      <section>
        <h2 className="text-lg font-semibold text-zinc-100 mb-4">Recent updates</h2>
        <ol className="relative border-l border-zinc-800 pl-6 space-y-4">
          {TIMELINE.map((t) => (
            <li key={t.date} className="relative">
              <span className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-zinc-950" />
              <div className="text-[10px] uppercase tracking-widest text-zinc-500 font-semibold">
                {t.date}
              </div>
              <div className="text-sm text-zinc-200">{t.title}</div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
