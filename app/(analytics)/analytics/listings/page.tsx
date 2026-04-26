import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Listings Analytics — Marketplace Depth and Time-on-Market",
  description:
    "Active listing depth, ask spread, and time-on-market for Flow collectibles marketplaces. See where supply is concentrated and how quickly inventory clears.",
  path: "/analytics/listings",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Listings Analytics",
  description:
    "Active listing depth and time-on-market for Flow digital collectibles marketplaces.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/listings`,
}

export default function ListingsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="Listings Analytics"
        expected="Q3 2026"
        description="A live view of every active listing across the Flow ecosystem. Track ask depth by edition, monitor how quickly listings convert to sales, and surface motivated sellers and capitulation events."
        metrics={[
          "Active listing count by collection and tier",
          "Ask spread vs FMV — discount distribution",
          "Average and median time-on-market by edition",
          "Capitulation signal — sudden price-cut detection",
          "Listing churn rate (created vs canceled vs sold)",
        ]}
      />
    </>
  )
}
