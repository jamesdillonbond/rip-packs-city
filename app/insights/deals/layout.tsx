// app/insights/deals/layout.tsx
//
// SEO surface for the public Below FMV board. Server component so the metadata
// export is honored (a "use client" page.tsx cannot export metadata). Canonical
// is param-stripped so ?player=/?set=/?tier= drill-downs don't index as
// duplicates (QA point 5). Mirrors app/insights/squeeze/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Below FMV — Top Shot Deals vs Fair Value | Rip Packs City",
  description:
    "Top Shot editions listed below a confidence-rated FMV — the public deals board. The top-of-funnel counterpart to the sniper. Free. No signup.",
  keywords: [
    "NBA Top Shot deals",
    "Top Shot below FMV",
    "Top Shot underpriced moments",
    "Top Shot discount",
    "Top Shot fair value",
    "Top Shot sniper",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/deals`,
  },
  openGraph: {
    title: "Below FMV — Top Shot Deals vs Fair Value",
    description:
      "Top Shot editions listed below a confidence-rated FMV. What's underpriced right now — the public deals board.",
    url: `${SITE_URL}/insights/deals`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/deals`,
        width: 1200,
        height: 630,
        alt: "Below FMV — Top Shot Deals vs Fair Value — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Below FMV — Top Shot Deals vs Fair Value",
    description:
      "Top Shot editions listed below a confidence-rated FMV — what's underpriced right now.",
    images: [`${SITE_URL}/api/og/insights/deals`],
    creator: "@RipPacksCity",
  },
}

export default function DealsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Below FMV — Top Shot Deals vs Fair Value",
    url: `${SITE_URL}/insights/deals`,
    description:
      "Ranks NBA Top Shot editions listed below a HIGH/MEDIUM-confidence FMV by discount. Refreshes continuously.",
    applicationCategory: "FinanceApplication",
    operatingSystem: "Any",
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    publisher: {
      "@type": "Organization",
      name: "Rip Packs City",
      url: SITE_URL,
    },
  }
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {children}
    </>
  )
}
