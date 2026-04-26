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

export const metadata: Metadata = analyticsMetadata({
  title: "Analytics — On-chain Intelligence for Flow Collectibles",
  description:
    "Comprehensive on-chain analytics across Flow's largest digital collectibles platforms — Top Shot, NFL All Day, Golazos, and Pinnacle. Live loan books, sales, listings, wallets, and FMV indices.",
  path: "/analytics",
})

interface SummaryResponse {
  totalLoans: number
  totalUsd: number
  uniqueLenders: number
  uniqueBorrowers: number
  newWallets: number
  activeCount: number
}

async function loadLoansSummary(): Promise<SummaryResponse | null> {
  try {
    const res = await fetch(`${ANALYTICS_BASE_URL}/api/analytics/loans/summary?window=ALL`, {
      next: { revalidate: 600 },
    })
    if (!res.ok) return null
    return (await res.json()) as SummaryResponse
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
  const summary = await loadLoansSummary()

  const cards: SectionCard[] = [
    {
      href: "/analytics/loans",
      label: "Loans",
      description: "Live Flowty loan book — capital deployed, rates, default tracking.",
      icon: HandCoins,
      status: "live",
      metrics: summary
        ? [
            { label: "Total volume", value: formatUsd(summary.totalUsd) },
            { label: "Active loans", value: formatCount(summary.activeCount) },
          ]
        : [{ label: "Status", value: "Live" }],
    },
    {
      href: "/analytics/pulse",
      label: "Pulse",
      description: "Cross-platform activity signal — sales, listings, holds, churn.",
      icon: Activity,
      status: "soon",
    },
    {
      href: "/analytics/sales",
      label: "Sales",
      description: "On-chain sales indexed across NFTStorefrontV2 and TopShotMarketV3.",
      icon: BarChart3,
      status: "soon",
    },
    {
      href: "/analytics/listings",
      label: "Listings",
      description: "Active listing depth, ask spread, time-on-market.",
      icon: List,
      status: "soon",
    },
    {
      href: "/analytics/wallets",
      label: "Wallets",
      description: "Wallet cohorts, holding patterns, accumulator vs flipper detection.",
      icon: Users,
      status: "soon",
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
    {
      href: "/analytics/fmv",
      label: "FMV Index",
      description: "Composite FMV indexes across collections, edition tiers, and rarity bands.",
      icon: Sparkles,
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
            return (
              <Link
                key={c.href}
                href={c.href}
                className="group relative rounded-xl border border-slate-800 bg-slate-900/40 p-5 transition-all hover:border-emerald-500/40 hover:bg-slate-900/70"
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/20">
                    <Icon size={16} className="text-emerald-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-slate-100">{c.label}</h3>
                      {c.status === "live" ? (
                        <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-emerald-400 border border-emerald-500/30">
                          Live
                        </span>
                      ) : (
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[9px] uppercase tracking-wider font-semibold text-slate-400 border border-slate-700">
                          Soon
                        </span>
                      )}
                    </div>
                  </div>
                  <ArrowUpRight
                    size={14}
                    className="text-slate-600 group-hover:text-emerald-400 transition-colors"
                  />
                </div>
                <p className="text-sm text-slate-400 leading-relaxed mb-3">{c.description}</p>
                {c.metrics ? (
                  <div className="flex gap-4 pt-3 border-t border-slate-800/80">
                    {c.metrics.map((m) => (
                      <div key={m.label}>
                        <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold">
                          {m.label}
                        </div>
                        <div className="text-base font-semibold text-slate-100 tabular-nums">
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
