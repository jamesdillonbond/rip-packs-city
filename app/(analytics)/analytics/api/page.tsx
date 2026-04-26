import type { Metadata } from "next"
import ComingSoon from "@/components/analytics/ComingSoon"
import { analyticsMetadata, ANALYTICS_BASE_URL } from "@/lib/analytics/seo"

export const metadata: Metadata = analyticsMetadata({
  title: "Public API — Programmatic Access to Rip Packs City Analytics",
  description:
    "Programmatic access to on-chain analytics for Flow collectibles. Loan books, sales, listings, FMV, and wallet cohorts via REST endpoints.",
  path: "/analytics/api",
})

const datasetJsonLd = {
  "@context": "https://schema.org",
  "@type": "Dataset",
  name: "Rip Packs City Public Analytics API",
  description:
    "Public REST API for on-chain analytics across Flow digital collectibles.",
  creator: { "@type": "Organization", name: "Rip Packs City" },
  url: `${ANALYTICS_BASE_URL}/analytics/api`,
}

export default function ApiPage() {
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(datasetJsonLd) }}
      />
      <ComingSoon
        section="Public API"
        expected="Q4 2026"
        description="A documented, versioned REST API exposing every analytic we publish here. Pull the loan book, sales, listings, FMV, and wallet cohorts directly into your own tools and dashboards."
        metrics={[
          "REST endpoints for loans, sales, listings, FMV, and wallets",
          "JSON, CSV, and Parquet export formats",
          "API keys with rate limiting and per-collection scopes",
          "Webhooks for real-time alerts on threshold crossings",
          "OpenAPI 3.1 spec with auto-generated typed clients",
        ]}
      />
    </>
  )
}
