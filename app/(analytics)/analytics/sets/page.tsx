import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Sets Analytics — Set Completion Rates and Bottleneck Moments",
  description:
    "Set completion rates and bottleneck moments by tier for Flow collectibles. Discover which sets are achievable and where the price walls live.",
  path: "/analytics/sets",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Sets Analytics",
  description:
    "Set completion rates and bottleneck moment analytics for Flow digital collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/sets`,
}

export default function SetsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="Sets Analytics"
        expected="Q4 2026"
        description="A set-level view of the Flow collectibles ecosystem. See completion rates per set, identify the bottleneck moments that gate completion, and track the cheapest path to finishing any set you choose."
        metrics={[
          "Completion rate per set across all wallets",
          "Bottleneck moments — lowest-supply edition gating completion",
          "Cheapest path to set completion at current asks",
          "Completed-set holders leaderboard",
          "Set value index over time",
        ]}
      />
    </>
  )
}
