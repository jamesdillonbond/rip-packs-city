import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Sales Analytics — On-chain Sales Across Flow Collectibles",
  description:
    "Sales analytics for NBA Top Shot, NFL All Day, LaLiga Golazos, and Disney Pinnacle, indexed directly from on-chain NFTStorefrontV2 and TopShotMarketV3 events.",
  path: "/analytics/sales",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Sales Analytics",
  description:
    "On-chain sales for Flow digital collectibles indexed from NFTStorefrontV2 and TopShotMarketV3.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/sales`,
}

export default function SalesPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="Sales Analytics"
        expected="Q3 2026"
        description="Every sale across every Flow collectibles marketplace, indexed from chain events. Filter by collection, set, tier, and serial range; chart volume and average sale price over arbitrary windows; identify trending editions before the rest of the market notices."
        metrics={[
          "Total sale volume by collection, tier, and set",
          "Average and median sale price per edition over time",
          "Top sales leaderboards (24h, 7d, 30d)",
          "Most-traded editions and largest single-sale highlights",
          "Buyer/seller flow — net accumulation per wallet",
        ]}
      />
    </>
  )
}
