// app/insights/pack-reality/layout.tsx
//
// SEO surface for the public Top Shot pack-reality board.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Top Shot Pack Reality | Rip Packs City",
  description:
    "We audited every Top Shot pack ripped in the last 60 days. 128,220 rips. Median pull value $0. Half of all packs delivered nothing. Free. No signup.",
  keywords: [
    "NBA Top Shot pack EV",
    "Top Shot pack value",
    "Top Shot pack odds",
    "Top Shot pack stats",
    "NBA Top Shot pack ripper",
    "Top Shot pack ROI",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/pack-reality`,
  },
  openGraph: {
    title: "Top Shot Pack Reality",
    description:
      "128,220 TS rips, last 60 days. Median pull value $0. 51% deliver nothing. 0.94% deliver over $100.",
    url: `${SITE_URL}/insights/pack-reality`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pack-reality`,
        width: 1200,
        height: 630,
        alt: "Top Shot Pack Reality — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Top Shot Pack Reality",
    description:
      "Median pull value $0. Half of all TS packs deliver nothing. Honest pack ranker, free.",
    images: [`${SITE_URL}/api/og/insights/pack-reality`],
    creator: "@RipPacksCity",
  },
}

export default function PackRealityLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Top Shot Pack Reality",
    url: `${SITE_URL}/insights/pack-reality`,
    description:
      "Audits every NBA Top Shot pack ripped in the last 60 days. Pull-value histogram, KPIs, and an honest +EV pack ranker with confidence flags.",
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
