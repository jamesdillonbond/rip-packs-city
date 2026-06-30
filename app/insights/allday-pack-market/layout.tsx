// app/insights/allday-pack-market/layout.tsx
//
// SEO surface for the public NFL All Day pack-market (sealed-pack resale) board.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "NFL All Day Pack Market | Rip Packs City",
  description:
    "What a sealed NFL All Day pack actually resells for — above or below its original drop price. Complete on-chain secondary sale history, ranked by discount, premium, and volume. Free. No signup.",
  keywords: [
    "NFL All Day pack price",
    "NFL All Day sealed pack",
    "All Day pack resale",
    "All Day pack secondary market",
    "NFL All Day pack value",
    "All Day pack discount",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/allday-pack-market`,
  },
  openGraph: {
    title: "NFL All Day Pack Market",
    description:
      "What a sealed NFL All Day pack actually resells for vs its drop price — discount, premium, and volume across the complete secondary sale history.",
    url: `${SITE_URL}/insights/allday-pack-market`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/allday-pack-market`,
        width: 1200,
        height: 630,
        alt: "NFL All Day Pack Market — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NFL All Day Pack Market",
    description:
      "What sealed NFL All Day packs resell for vs their drop price. Honest secondary-market read, free.",
    images: [`${SITE_URL}/api/og/insights/allday-pack-market`],
    creator: "@RipPacksCity",
  },
}

export default function AllDayPackMarketLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "NFL All Day Pack Market",
    url: `${SITE_URL}/insights/allday-pack-market`,
    description:
      "Ranks NFL All Day sealed packs by what they actually resell for on the secondary market vs their original drop price, from the complete on-chain sale history. Packs with 5+ secondary sales qualify.",
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
