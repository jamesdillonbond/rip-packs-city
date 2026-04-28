import type { Metadata } from "next"
import LoansDashboard from "@/components/analytics/LoansDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Flowty Loan Analytics — On-chain NFT-Collateralized Lending on Flow",
  description:
    "Live Flowty loan book for Flow digital collectibles. Capital deployed, lender and borrower leaderboards, cohort retention, and outstanding principal — refreshed every 10 minutes.",
  path: "/analytics/loans",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Flowty Loan Analytics",
  description:
    "On-chain Flowty loan book and derived analytics for Flow digital collectibles — Top Shot, NFL All Day, Golazos, and Pinnacle.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/loans`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/loans/summary`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/loans/timeseries`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/loans/limbo-summary`,
    },
  ],
  variableMeasured: [
    "Total loan volume (USD)",
    "Unique lenders",
    "Unique borrowers",
    "Active loans",
    "Outstanding principal",
    "Average interest rate",
    "Average term (days)",
    "Open listings count",
    "Settled loans (default-rate proxy)",
    "Limbo recovery cohort (pre-pause loans)",
  ],
}

export default function LoansPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <LoansDashboard />
    </>
  )
}
