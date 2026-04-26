import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Market Pulse — Cross-Platform Activity Signal",
  description:
    "Cross-platform activity signal for Flow collectibles. Sales velocity, listing churn, holder rotation, and unusual market behavior, surfaced in real time.",
  path: "/analytics/pulse",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Market Pulse",
  description:
    "Cross-platform activity signal for Flow digital collectibles — Top Shot, NFL All Day, Golazos, Pinnacle.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/pulse`,
}

export default function PulsePage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="Market Pulse"
        expected="Q3 2026"
        description="A unified, real-time activity signal across every Flow collectibles platform we index. Pulse will combine sales velocity, listing churn, and holder rotation into a single signal you can monitor at a glance — with alerts for unusual market behavior."
        metrics={[
          "Cross-platform activity index, weighted by volume and unique participants",
          "Listing churn rate and average time-on-market by collection",
          "Holder rotation — how quickly moments change hands",
          "Anomaly detection for unusual price moves and volume spikes",
        ]}
      />
    </>
  )
}
