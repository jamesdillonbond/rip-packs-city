import type { Metadata } from "next"
import PulseDashboard from "@/components/analytics/PulseDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Pulse — Live Flow NFT Activity",
  description:
    "Real-time transaction stream across loans, sales, and listings on the Flow blockchain — Top Shot, NFL All Day, Golazos, UFC Strike, Pinnacle. Refreshes automatically.",
  path: "/analytics/pulse",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Pulse",
  description:
    "Live activity stream combining loan originations, repayments, settlements, and marketplace sales across Flow digital collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/pulse`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/pulse/24h`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/pulse/activity`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/pulse/hourly`,
    },
  ],
}

export default function PulsePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <PulseDashboard />
    </>
  )
}
