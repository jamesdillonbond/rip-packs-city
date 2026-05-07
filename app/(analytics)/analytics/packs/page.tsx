import type { Metadata } from "next"
import PacksDashboard from "@/components/analytics/PacksDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Pack Analytics — Pack EV, Drop History, Supply Curves",
  description:
    "Pack drop analytics for Flow collectibles. Expected value, pull odds, supply curves, and historical opening behavior across every pack.",
  path: "/analytics/packs",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Pack Analytics",
  description:
    "Pack drop analytics, expected value, and pull odds for Flow digital collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/packs`,
}

export default function PacksPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <PacksDashboard />
    </>
  )
}
