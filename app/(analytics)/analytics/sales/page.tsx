import type { Metadata } from "next"
import SalesDashboard from "@/components/analytics/SalesDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Sales Analytics — On-chain Sales Across Flow Collectibles",
  description:
    "Live secondary-market sales across NBA Top Shot, NFL All Day, LaLiga Golazos, UFC Strike, and Disney Pinnacle. Volume, leaderboards, and biggest sales — refreshed every 10 minutes.",
  path: "/analytics/sales",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Sales Analytics",
  description:
    "On-chain sales for Flow digital collectibles indexed from NFTStorefrontV2, TopShotMarketV3, NFL All Day, Golazos, and Pinnacle Trade events.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/sales`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/summary`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/timeseries`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/leaderboard`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sales/top-moves`,
    },
  ],
  variableMeasured: [
    "Total sale volume (USD)",
    "Sale count",
    "Unique buyers (on-chain only)",
    "Unique sellers (on-chain only)",
    "Average sale price",
    "Median sale price",
    "Marketplace mix (Top Shot, Flowty, Pinnacle direct)",
    "Top buyers and sellers by volume",
    "Largest single sales",
  ],
}

export default function SalesPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <SalesDashboard />
    </>
  )
}
