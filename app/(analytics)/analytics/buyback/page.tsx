import type { Metadata } from "next"
import BuybackDashboard from "@/components/analytics/BuybackDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Top Shot Buyback Wallets — Accumulation & Spend",
  description:
    "What NBA Top Shot's secondary-buyback wallets are accumulating, by week, month, year and all tracked time — most-acquired moments, priced spend, and the sellers they buy from.",
  path: "/analytics/buyback",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City — Top Shot Buyback Wallet Activity",
  description:
    "Acquisition volume and priced spend for the NBA Top Shot secondary-buyback wallets, aggregated daily. Acquisition counts are complete; dollar figures cover only the marketplace purchases that carry an on-chain price.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/buyback`,
  distribution: [
    {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: `${ANALYTICS_BASE_URL}/api/analytics/buyback`,
    },
  ],
}

// Thin server wrapper; the client body lives in components/analytics, which is
// inside the component coverage gate's include. Keeping page.tsx free of both
// "use client" and direct data access keeps it off the client-page and
// server-page-data-access ratchets.
export default function BuybackPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <BuybackDashboard />
    </>
  )
}
