// Per-collection drill-down for the loan analytics dashboard.
// Renders the same LoansDashboard component but pre-filtered to a single
// Flowty-supported collection. The dashboard's collection-toggle chips
// are hidden in this mode since the URL already represents the scope.

import type { Metadata } from "next"
import Link from "next/link"
import { ChevronLeft } from "lucide-react"
import { notFound } from "next/navigation"
import LoansDashboard from "@/components/analytics/LoansDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

interface CollectionConfig {
  slug: string
  label: string
  shortLabel: string
  // Single-line marketing description used in metadata + page header.
  pitch: string
  // 3-4 sentence body description used as schema.org Dataset.description.
  description: string
}

const COLLECTIONS: Record<string, CollectionConfig> = {
  topshot: {
    slug: "topshot",
    label: "NBA Top Shot",
    shortLabel: "Top Shot",
    pitch:
      "Historical capital flow on NBA Top Shot peer-to-peer NFT-collateralized loans through Flowty.",
    description:
      "On-chain Flowty loan book for NBA Top Shot moments. Capital deployed, lender and borrower leaderboards, monthly cohorts, and outstanding principal — historical archive (Flowty closed its marketplace May 2026).",
  },
  allday: {
    slug: "allday",
    label: "NFL All Day",
    shortLabel: "All Day",
    pitch:
      "Historical capital flow on NFL All Day peer-to-peer NFT-collateralized loans through Flowty.",
    description:
      "On-chain Flowty loan book for NFL All Day moments. Capital deployed, lender and borrower leaderboards, monthly cohorts, and outstanding principal — historical archive (Flowty closed its marketplace May 2026).",
  },
  golazos: {
    slug: "golazos",
    label: "LaLiga Golazos",
    shortLabel: "Golazos",
    pitch:
      "Historical capital flow on LaLiga Golazos peer-to-peer NFT-collateralized loans through Flowty.",
    description:
      "On-chain Flowty loan book for LaLiga Golazos moments. Capital deployed, lender and borrower leaderboards, monthly cohorts, and outstanding principal — historical archive (Flowty closed its marketplace May 2026).",
  },
  pinnacle: {
    slug: "pinnacle",
    label: "Disney Pinnacle",
    shortLabel: "Pinnacle",
    pitch:
      "Historical capital flow on Disney Pinnacle peer-to-peer NFT-collateralized loans through Flowty.",
    description:
      "On-chain Flowty loan book for Disney Pinnacle pins. Capital deployed, lender and borrower leaderboards, monthly cohorts, and outstanding principal — historical archive (Flowty closed its marketplace May 2026).",
  },
  ufc: {
    slug: "ufc",
    label: "UFC Strike",
    shortLabel: "UFC",
    pitch:
      "Historical capital flow on UFC Strike peer-to-peer NFT-collateralized loans through Flowty.",
    description:
      "On-chain Flowty loan book for UFC Strike collectibles. Capital deployed, lender and borrower leaderboards, monthly cohorts, and outstanding principal — historical archive (Flowty closed its marketplace May 2026).",
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
      title: "Loan analytics — Rip Packs City",
    }
  }
  return analyticsMetadata({
    title: `${cfg.label} Loan Analytics — Rip Packs City`,
    description: cfg.pitch,
    path: `/analytics/loans/${cfg.slug}`,
  })
}

export default async function CollectionLoansPage({ params }: PageParams) {
  const { collection } = await params
  const cfg = COLLECTIONS[collection]
  if (!cfg) notFound()

  const datasetJsonLd = {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `Rip Packs City Flowty Loan Analytics — ${cfg.label}`,
    description: cfg.description,
    creator: { "@type": "Organization", name: "Rip Packs City" },
    url: `${ANALYTICS_BASE_URL}/analytics/loans/${cfg.slug}`,
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/loans/summary?collections=${cfg.slug}`,
      },
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/loans/timeseries?collections=${cfg.slug}`,
      },
    ],
    variableMeasured: [
      "Total loan volume (USD)",
      "Unique lenders",
      "Unique borrowers",
      "Active loans",
      "Outstanding principal",
      "Average APR",
      "Default rate",
    ],
  }

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <div className="space-y-6">
        <nav className="flex items-center gap-2 text-xs text-zinc-500">
          <Link
            href="/analytics/loans"
            className="inline-flex items-center gap-1 hover:text-emerald-400 transition-colors"
          >
            <ChevronLeft size={12} />
            All loans
          </Link>
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-300">{cfg.label}</span>
        </nav>

        <LoansDashboard
          collection={cfg.slug}
          title={`${cfg.label} Loan Analytics`}
          subtitle={cfg.pitch + " Data refreshes every 10 minutes."}
          hideExploreSection
        />
      </div>
    </>
  )
}
