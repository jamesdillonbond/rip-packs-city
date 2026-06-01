// app/insights/offer-spread/layout.tsx
//
// SEO surface for the public Bid vs Floor board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata).
// Canonical is param-stripped so ?player=/?set=/?tier= drill-downs don't index
// as duplicates (QA point 5). Mirrors app/insights/squeeze/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Bid vs Floor — Top Shot Offer/Ask Spread | Rip Packs City",
  description:
    "Top Shot editions where the top standing offer meets or approaches the floor ask — liquidity and bid-vs-floor intelligence. Free. No signup.",
  keywords: [
    "NBA Top Shot offers",
    "Top Shot bid vs ask",
    "Top Shot offer spread",
    "Top Shot floor ask",
    "Top Shot liquidity",
    "Top Shot standing offers",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/offer-spread`,
  },
  openGraph: {
    title: "Bid vs Floor — Top Shot Offer/Ask Spread",
    description:
      "Top Shot editions where the top standing offer meets or approaches the floor ask. The bid-vs-floor signal no native surface shows.",
    url: `${SITE_URL}/insights/offer-spread`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/offer-spread`,
        width: 1200,
        height: 630,
        alt: "Bid vs Floor — Top Shot Offer/Ask Spread — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Bid vs Floor — Top Shot Offer/Ask Spread",
    description:
      "Top Shot editions where the top standing offer meets or approaches the floor ask.",
    images: [`${SITE_URL}/api/og/insights/offer-spread`],
    creator: "@RipPacksCity",
  },
}

export default function OfferSpreadLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Bid vs Floor — Top Shot Offer/Ask Spread",
    url: `${SITE_URL}/insights/offer-spread`,
    description:
      "Ranks NBA Top Shot editions by how tightly the top standing offer meets the floor ask. Refreshes continuously.",
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
