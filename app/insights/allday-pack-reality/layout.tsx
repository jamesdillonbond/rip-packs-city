// app/insights/allday-pack-reality/layout.tsx
//
// SEO surface for the public NFL All Day pack-reality (model-vs-reality) board.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "NFL All Day Pack Reality | Rip Packs City",
  description:
    "What the model says vs what NFL All Day packs actually pull. We compare each pack's odds-corrected expected value against the value its opened packs really delivered, resolved on-chain. Free. No signup.",
  keywords: [
    "NFL All Day pack EV",
    "NFL All Day pack value",
    "NFL All Day pack odds",
    "All Day pack reality",
    "All Day pack ROI",
    "NFL All Day pack ripper",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/allday-pack-reality`,
  },
  openGraph: {
    title: "NFL All Day Pack Reality",
    description:
      "The model says one number — opened packs pull another. Modeled EV vs realized pulls for NFL All Day packs, resolved on-chain.",
    url: `${SITE_URL}/insights/allday-pack-reality`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/allday-pack-reality`,
        width: 1200,
        height: 630,
        alt: "NFL All Day Pack Reality — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NFL All Day Pack Reality",
    description:
      "Modeled EV vs realized pulls for NFL All Day packs. Honest model-vs-reality check, free.",
    images: [`${SITE_URL}/api/og/insights/allday-pack-reality`],
    creator: "@RipPacksCity",
  },
}

export default function AllDayPackRealityLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "NFL All Day Pack Reality",
    url: `${SITE_URL}/insights/allday-pack-reality`,
    description:
      "Compares each NFL All Day pack's odds-corrected modeled EV against the value its opened packs actually delivered, resolved on-chain. Sparse-data and stale-FMV dists are excluded.",
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
