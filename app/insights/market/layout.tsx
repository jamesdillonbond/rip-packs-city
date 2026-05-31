// app/insights/market/layout.tsx
//
// SEO surface for The RPC Index (tier-segmented Top Shot market index). Server
// component so the metadata export is honored (a "use client" page.tsx cannot
// export metadata directly). Mirrors app/insights/squeeze/layout.tsx.
//
// Self-canonical is param-stripped so any future filtered URLs don't index as
// duplicates of the base board.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "The RPC Index — Tier-Segmented Top Shot Market | Rip Packs City",
  description:
    "Top Shot's blended floor is a sub-$1 number dominated by commons. The RPC Index segments the market by tier and normalizes each to 100 — a free, honest read of Legendary, Rare, Fandom, and Common momentum. No signup.",
  keywords: [
    "NBA Top Shot market index",
    "Top Shot price index",
    "Top Shot market trend",
    "Top Shot tier prices",
    "Top Shot legendary price",
    "Top Shot volume",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/market`,
  },
  openGraph: {
    title: "The RPC Index — Tier-Segmented Top Shot Market",
    description:
      "One blended floor hides everything. The RPC Index segments Top Shot by tier and indexes each to 100 — honest market momentum.",
    url: `${SITE_URL}/insights/market`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/market`,
        width: 1200,
        height: 630,
        alt: "The RPC Index — Tier-Segmented Top Shot Market — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "The RPC Index — Tier-Segmented Top Shot Market",
    description:
      "One blended floor hides everything. The RPC Index segments Top Shot by tier and indexes each to 100.",
    images: [`${SITE_URL}/api/og/insights/market`],
    creator: "@RipPacksCity",
  },
}

export default function MarketIndexLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "The RPC Index",
    url: `${SITE_URL}/insights/market`,
    description:
      "A tier-segmented daily market index for NBA Top Shot built from real secondary-market sales. Each tier is normalized to 100 at the start of the window.",
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
