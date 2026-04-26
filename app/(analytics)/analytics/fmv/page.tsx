import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "FMV Index — Composite Fair-Market-Value Indices for Flow Collectibles",
  description:
    "Composite FMV indices across Flow collectibles, by collection, tier, and rarity band. Track the broad market and specific segments at a glance.",
  path: "/analytics/fmv",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City FMV Index",
  description:
    "Composite fair-market-value indices for Flow digital collectibles by collection, tier, and rarity band.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/fmv`,
}

export default function FmvPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="FMV Index"
        expected="Q4 2026"
        description="A composite FMV index for Flow collectibles. We&apos;re building benchmark indices by collection, tier, and rarity band so you can see whether the broader market — or a specific segment — is trending up or down at a glance."
        metrics={[
          "Top Shot, NFL All Day, Golazos, and Pinnacle composite indices",
          "Tier-stratified indices (Common, Rare, Legendary, Ultimate)",
          "Rookie & low-serial premium indices",
          "Index methodology with weights, sample size, and confidence bands",
          "Historical index reconstruction from on-chain sales",
        ]}
      />
    </>
  )
}
