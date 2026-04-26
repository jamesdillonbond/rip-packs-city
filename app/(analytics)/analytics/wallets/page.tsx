import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Wallets Analytics — Cohorts, Holders, and Market Behavior",
  description:
    "Wallet cohorts, holding patterns, and behavioral classification for Flow collectible wallets. Identify accumulators, flippers, and whales.",
  path: "/analytics/wallets",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Wallet Analytics",
  description:
    "Wallet cohort and holding-pattern analytics for Flow digital collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/wallets`,
}

export default function WalletsPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="Wallets Analytics"
        expected="Q3 2026"
        description="A behavioral classification of every wallet that touches Flow collectibles. Cohort wallets by first activity quarter, classify them as accumulator/flipper/whale based on holding patterns, and track active-user metrics over time."
        metrics={[
          "Daily, weekly, and monthly active wallets per collection",
          "New wallet acquisition by week with cohort retention",
          "Behavioral classification — accumulator, flipper, whale",
          "Holder concentration — Gini coefficient and whale share",
          "Wallet age distribution and re-engagement signal",
        ]}
      />
    </>
  )
}
