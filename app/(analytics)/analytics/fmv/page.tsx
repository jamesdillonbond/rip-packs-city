import type { Metadata } from "next"
import FmvDashboard from "@/components/analytics/FmvDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "FMV Index — Fair Market Value Across Flow NFTs",
  description:
    "Algorithmic fair-market-value pricing across NBA Top Shot and NFL All Day editions. Pipeline health, top movers, and tier-by-tier FMV distribution. Refreshes every 10 minutes.",
  path: "/analytics/fmv",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City FMV Index",
  description:
    "Algorithmic fair-market-value pricing across Flow digital collectibles. Per-edition FMV with confidence levels, top movers, and per-tier roll-ups.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/fmv`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/fmv/health`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/fmv/top-movers`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/fmv/tier-pulse`,
    },
  ],
}

export default function FmvPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <FmvDashboard />
    </>
  )
}
