// Per-collection drill-down for the sales analytics dashboard.
// Mirrors /analytics/loans/[collection] — same SalesDashboard component
// pre-filtered to a single collection. The collection-toggle chips are
// hidden in this mode since the URL already represents the scope.

import type { Metadata } from "next"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { notFound } from "next/navigation"
import SalesDashboard from "@/components/analytics/SalesDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

interface CollectionConfig {
  slug: string
  label: string
  shortLabel: string
  pitch: string
  description: string
}

const COLLECTIONS: Record<string, CollectionConfig> = {
  topshot: {
    slug: "topshot",
    label: "NBA Top Shot",
    shortLabel: "Top Shot",
    pitch:
      "Live secondary-market sales for NBA Top Shot moments — the largest Flow-collectibles marketplace by volume.",
    description:
      "On-chain and centralized-marketplace sales for NBA Top Shot. Volume trends, top buyers and sellers, and the biggest single sales — refreshed every 10 minutes.",
  },
  allday: {
    slug: "allday",
    label: "NFL All Day",
    shortLabel: "All Day",
    pitch: "Live secondary-market sales for NFL All Day moments.",
    description:
      "On-chain sales for NFL All Day moments. Volume trends, top buyers and sellers, and the biggest single sales — refreshed every 10 minutes.",
  },
  golazos: {
    slug: "golazos",
    label: "LaLiga Golazos",
    shortLabel: "Golazos",
    pitch: "Live secondary-market sales for LaLiga Golazos moments.",
    description:
      "On-chain sales for LaLiga Golazos. Volume trends, top buyers and sellers, and the biggest single sales — refreshed every 10 minutes.",
  },
  pinnacle: {
    slug: "pinnacle",
    label: "Disney Pinnacle",
    shortLabel: "Pinnacle",
    pitch:
      "Live direct on-chain Pinnacle sales — full wallet detail preserved on every trade.",
    description:
      "Direct on-chain Pinnacle.Trade sales for Disney Pinnacle pins. Full participant wallets are preserved (unlike Top Shot's centralized market), so leaderboards reflect every active trader.",
  },
  ufc: {
    slug: "ufc",
    label: "UFC Strike",
    shortLabel: "UFC",
    pitch: "Live secondary-market sales for UFC Strike collectibles.",
    description:
      "On-chain sales for UFC Strike collectibles. Volume trends, top buyers and sellers, and the biggest single sales — refreshed every 10 minutes.",
  },
}

interface PageParams {
  params: Promise<{ collection: string }>
}

export const revalidate = 600

export function generateStaticParams() {
  return Object.keys(COLLECTIONS).map((collection) => ({ collection }))
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { collection } = await params
  const cfg = COLLECTIONS[collection]
  if (!cfg) {
    return {
      title: "Sales analytics — Rip Packs City",
    }
  }
  return analyticsMetadata({
    title: `${cfg.label} Sales Analytics — Rip Packs City`,
    description: cfg.pitch,
    path: `/analytics/sales/${cfg.slug}`,
  })
}

export default async function CollectionSalesPage({ params }: PageParams) {
  const { collection } = await params
  const cfg = COLLECTIONS[collection]
  if (!cfg) notFound()

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Rip Packs City Sales Analytics — ${cfg.label}`,
    description: cfg.description,
    creator: { "@type": "Organization", name: "Rip Packs City" },
    url: `${ANALYTICS_BASE_URL}/analytics/sales/${cfg.slug}`,
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/summary?collections=${cfg.slug}`,
      },
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/timeseries?collections=${cfg.slug}`,
      },
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/top-moves?collections=${cfg.slug}`,
      },
    ],
    variableMeasured: [
      "Total sale volume (USD)",
      "Sale count",
      "Average and median sale price",
      "Top buyers and sellers by volume",
      "Largest single sales",
      "Marketplace mix",
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <div className="space-y-6">
        <nav className="flex items-center gap-2 text-xs text-[color:var(--rpc-text-muted)]">
          <Link
            href="/analytics/sales"
            className="inline-flex items-center gap-1 hover:text-emerald-400 transition-colors"
          >
            <ChevronLeft size={12} />
            All sales
          </Link>
          <span className="text-[color:var(--rpc-text-ghost)]">·</span>
          <span className="text-[color:var(--rpc-text-secondary)]">{cfg.label}</span>
        </nav>

        <SalesDashboard
          collection={cfg.slug}
          title={`${cfg.label} Sales Analytics`}
          subtitle={cfg.pitch + " Data refreshes every 10 minutes."}
          hideExploreSection
        />
      </div>
    </>
  )
}
