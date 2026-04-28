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

interface WalletDirectoryCardRow {
  addr: string
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

async function loadWalletDirectoryCount(): Promise<number | null> {
  try {
    const sb: any = supabaseAdmin
    const { data, error } = await sb.rpc("flowty_analytics_wallet_directory")
    if (error || !Array.isArray(data)) return null
    return (data as WalletDirectoryCardRow[]).length
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
  status: "live" | "soon"
}

const TIMELINE = [
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
  const [summary, salesSummary, pulse, listings, fmvHealth, walletCount] =
    await Promise.all([
      loadLoansSummary(),
      loadSalesSummary(),
      loadPulse24h(),
      loadListingsSummary(),
      loadFmvHealth(),
      loadWalletDirectoryCount(),
    ])

  let fmvTotalUsd = 0
  let fmvEditionTotal = 0
  if (fmvHealth?.collections) {
    for (const stats of Object.values(fmvHealth.collections)) {
      fmvTotalUsd += stats?.reliable_total_fmv_usd ?? 0
      fmvEditionTotal += stats?.editions_total ?? 0
    }
  }

  const cards: SectionCard[] = [
    {
      href: "/analytics/loans",
      label: "Loans",
      description: "Live Flowty loan book — capital deployed, rates, default tracking.",
      icon: HandCoins,
      status: "live",
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
      metrics:
        walletCount != null
          ? [
              { label: "Active wallets", value: formatCount(walletCount) },
              { label: "Source", value: "Loan book" },
            ]
          : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/fmv",
      label: "FMV Index",
      description: "Algorithmic fair-market-value pricing across NBA Top Shot and NFL All Day editions.",
      icon: Sparkles,
      status: "live",
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
      description: "Pack drops, EV, pull odds, supply curves over time.",
      icon: Package,
      status: "soon",
    },
    {
      href: "/analytics/sets",
      label: "Sets",
      description: "Set completion rates and bottleneck moments by tier.",
      icon: Layers,
      status: "soon",
    },
  ]

  return (
    <div className="space-y-10">
      {/* Hero */}
      <section className="rounded-xl border border-slate-800 bg-gradient-to-br from-slate-900 to-slate-950 px-6 py-8 sm:px-8 sm:py-10">
        <div className="text-[10px] uppercase tracking-widest text-emerald-400 mb-2 font-semibold">
          Rip Packs City Analytics
        </div>
        <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-slate-50 mb-3">
          Analytics
        </h1>
        <p className="text-slate-300 max-w-2xl leading-relaxed">
          Comprehensive on-chain analytics across Flow&apos;s largest digital collectibles
          platforms. Loan books, sales, listings, wallet cohorts, and FMV indices —
          updated continuously from chain events.
        </p>
      </section>

      {/* Section grid */}
      <section>
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Sections</h2>
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {cards.map((c) => {
            const Icon = c.icon
            const isLive = c.status === "live"
            return (
              <Link
                key={c.href}
                href={c.href}
                className={
                  "group relative rounded-xl border p-5 transition-all " +
                  (isLive
                    ? "border-slate-800 bg-slate-900/40 hover:border-emerald-500/40 hover:bg-slate-900/70"
                    : "border-slate-800/60 bg-slate-900/20 opacity-60 hover:opacity-80 hover:border-slate-700")
                }
              >
                <div className="flex items-start gap-3 mb-3">
                  <div
                    className={
                      "flex h-9 w-9 items-center justify-center rounded-md border " +
                      (isLive
                        ? "bg-emerald-500/10 border-emerald-500/20"
                        : "bg-slate-800/40 border-slate-700/50")
                    }
                  >
                    <Icon
                      size={16}
                      className={isLive ? "text-emerald-400" : "text-slate-500"}
                    />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3
                        className={
                          "font-semibold " +
                          (isLive ? "text-slate-100" : "text-slate-400")
                        }
                      >
                        {c.label}
                      </h3>
                      {isLive ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-emerald-400 border border-emerald-500/30">
                          Live
                        </span>
                      ) : (
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-slate-500 border border-slate-700/70">
                          Coming Soon
                        </span>
                      )}
                    </div>
                  </div>
                  <ArrowUpRight
                    size={14}
                    className={
                      isLive
                        ? "text-slate-600 group-hover:text-emerald-400 transition-colors"
                        : "text-slate-700"
                    }
                  />
                </div>
                <p
                  className={
                    "text-sm leading-relaxed mb-3 " +
                    (isLive ? "text-slate-400" : "text-slate-500")
                  }
                >
                  {c.description}
                </p>
                {c.metrics ? (
                  <div className="flex gap-4 pt-3 border-t border-slate-800/80">
                    {c.metrics.map((m) => (
                      <div key={m.label}>
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                          {m.label}
                        </div>
                        <div
                          className={
                            "text-base font-semibold tabular-nums " +
                            (isLive ? "text-slate-100" : "text-slate-400")
                          }
                        >
                          {m.value}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Link>
            )
          })}
        </div>
      </section>

      {/* Recent updates timeline */}
      <section>
        <h2 className="text-lg font-semibold text-slate-100 mb-4">Recent updates</h2>
        <ol className="relative border-l border-slate-800 pl-6 space-y-4">
          {TIMELINE.map((t) => (
            <li key={t.date} className="relative">
              <span className="absolute -left-[27px] top-1.5 h-2 w-2 rounded-full bg-emerald-500 ring-2 ring-slate-950" />
              <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                {t.date}
              </div>
              <div className="text-sm text-slate-200">{t.title}</div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
