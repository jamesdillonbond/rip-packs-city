import type { Metadata } from "next"
import BuybackDashboard from "@/components/analytics/BuybackDashboard"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Buyback Tracker — NBA Top Shot & NFL All Day",
  description:
    "What NBA Top Shot's buyback wallets and NFL All Day's pack buybacks are accumulating, by week, month, year and all tracked time — most-bought moments, spend, and the sellers they buy from.",
  path: "/analytics/buyback",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City — Buyback Activity (NBA Top Shot & NFL All Day)",
  description:
    "Purchases and spend by the NBA Top Shot buyback wallets and the NFL All Day issuer (pack buybacks), from recorded sales, aggregated daily. These purchases also count as market sales elsewhere on Rip Packs City.",
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
