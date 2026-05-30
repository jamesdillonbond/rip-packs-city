// app/insights/squeeze/layout.tsx
//
// SEO surface for the public lock-rate squeeze board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata
// directly). Mirrors the pattern used by app/nba/fast-break/layout.tsx.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Top Shot Lock-Rate Squeeze Board | Rip Packs City",
  description:
    "Top Shot displays circulation. We display effective supply. The lock-rate squeeze board ranks NBA Top Shot editions by how locked + burned their circulation actually is. Free. No signup.",
  keywords: [
    "NBA Top Shot squeeze",
    "Top Shot lock rate",
    "Top Shot effective supply",
    "Top Shot burned moments",
    "Top Shot challenge lock",
    "NBA Top Shot moments locked",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/squeeze`,
  },
  openGraph: {
    title: "Top Shot Lock-Rate Squeeze Board",
    description:
      "Top Shot shows circulation. We show effective supply — the moments actually purchasable after locks + burns.",
    url: `${SITE_URL}/insights/squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/squeeze`,
        width: 1200,
        height: 630,
        alt: "Top Shot Lock-Rate Squeeze Board — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Shot Lock-Rate Squeeze Board",
    description:
      "Top Shot shows circulation. We show effective supply — the moments actually purchasable after locks + burns.",
    images: [`${SITE_URL}/api/og/insights/squeeze`],
    creator: "@RipPacksCity",
  },
}

export default function SqueezeLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Top Shot Lock-Rate Squeeze Board",
    url: `${SITE_URL}/insights/squeeze`,
    description:
      "Ranks NBA Top Shot editions by effective supply (circulation minus locked minus burned). Refreshes hourly.",
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
