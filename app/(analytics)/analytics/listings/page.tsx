import type { Metadata } from "next"
import ListingsDashboard from "@/components/analytics/ListingsDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Listings — Open Offers and Orderbook",
  description:
    "Historical Flowty loan offers and a sample of the Top Shot orderbook. Marketplace ask data sourced from the Sniper deal feed across Top Shot, NFL All Day, Golazos, UFC, and Pinnacle. Flowty loan offers are a frozen archive (marketplace closed May 2026).",
  path: "/analytics/listings",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Listings Analytics",
  description:
    "Historical Flowty loan offers (marketplace closed May 2026) and a periodically-sampled snapshot of the Top Shot marketplace orderbook plus Sniper-feed asks across other Flow collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/listings`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/listings/summary`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/listings/loan-offers`,
    },
  ],
}

export default function ListingsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ListingsDashboard />
    </>
  )
}
