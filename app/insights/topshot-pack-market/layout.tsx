// app/insights/topshot-pack-market/layout.tsx
//
// SEO surface for the public NBA Top Shot pack-market (sealed-pack resale) board.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "NBA Top Shot Pack Market | Rip Packs City",
  description:
    "What a sealed NBA Top Shot pack actually resells for — above or below its original drop price. Complete on-chain secondary sale history, ranked by discount, premium, and volume. Free. No signup.",
  keywords: [
    "NBA Top Shot pack price",
    "NBA Top Shot sealed pack",
    "Top Shot pack resale",
    "Top Shot pack secondary market",
    "NBA Top Shot pack value",
    "Top Shot pack discount",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/topshot-pack-market`,
  },
  openGraph: {
    title: "NBA Top Shot Pack Market",
    description:
      "What a sealed NBA Top Shot pack actually resells for vs its drop price — discount, premium, and volume across the complete secondary sale history.",
    url: `${SITE_URL}/insights/topshot-pack-market`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/topshot-pack-market`,
        width: 1200,
        height: 630,
        alt: "NBA Top Shot Pack Market — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NBA Top Shot Pack Market",
    description:
      "What sealed NBA Top Shot packs resell for vs their drop price. Honest secondary-market read, free.",
    images: [`${SITE_URL}/api/og/insights/topshot-pack-market`],
    creator: "@RipPacksCity",
  },
}

export default function TopShotPackMarketLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "NBA Top Shot Pack Market",
    url: `${SITE_URL}/insights/topshot-pack-market`,
    description:
      "Ranks NBA Top Shot sealed packs by what they actually resell for on the secondary market vs their original drop price, from the complete on-chain sale history. Packs with 5+ secondary sales qualify.",
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
