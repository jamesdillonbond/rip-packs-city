import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
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
      <ComingSoon
        section="Pack Analytics"
        expected="Q4 2026"
        description="Comprehensive pack-drop intelligence across every Flow collectibles platform. Live EV calculations, historical pull odds, supply curves, and an opening-behavior index that tells you whether a pack is being held or ripped."
        metrics={[
          "Live expected value by pack with confidence bands",
          "Historical pull odds by tier",
          "Supply curve — packs minted, opened, and held over time",
          "Pack price vs floor moment — break-even analysis",
          "Hold rate — % of packs unopened by drop",
        ]}
      />
    </>
  )
}
