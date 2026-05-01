import type { Metadata } from "next"
import SetsDashboard from "@/components/analytics/SetsDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Sets — Catalog Across Flow NFT Collections",
  description:
    "Set-level rollups across NBA Top Shot, NFL All Day, LaLiga Golazos, and UFC Strike. Catalog summary, series eras, and a sortable directory of every set with FMV coverage and robust total value.",
  path: "/analytics/sets",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Sets Catalog",
  description:
    "Set-level catalog rollups across NBA Top Shot, NFL All Day, LaLiga Golazos, and UFC Strike — set/edition counts, tier breakdowns, series eras, and per-set FMV totals.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/sets`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sets/summary`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sets/series`,
    },
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/sets/directory`,
    },
  ],
}

export default function SetsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <SetsDashboard />
    </>
  )
}
