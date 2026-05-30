// app/insights/rookies/layout.tsx
//
// SEO surface for the public 2025 NBA Rookie Class Index.

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "2025 NBA Rookie Class Index | Rip Packs City",
  description:
    "The 2025 NBA rookie class on Top Shot — 30-day GMV, lock rates, average prices, first-mint trophy multipliers. Dylan Harper, Cooper Flagg, Kon Knueppel, VJ Edgecombe. Free. No signup.",
  keywords: [
    "NBA Top Shot rookies",
    "2025 NBA Draft Top Shot",
    "Top Shot rookie ranking",
    "Cooper Flagg Top Shot",
    "Dylan Harper Top Shot",
    "Kon Knueppel Top Shot",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/rookies`,
  },
  openGraph: {
    title: "2025 NBA Rookie Class Index",
    description:
      "30-day GMV, lock rates, mint #1 trophy presence across the 2025 NBA rookie class on Top Shot.",
    url: `${SITE_URL}/insights/rookies`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/rookies`,
        width: 1200,
        height: 630,
        alt: "2025 NBA Rookie Class Index — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "2025 NBA Rookie Class Index",
    description:
      "The 2025 NBA rookie class on Top Shot. GMV, lock rates, first-mint trophies.",
    images: [`${SITE_URL}/api/og/insights/rookies`],
    creator: "@RipPacksCity",
  },
}

export default function RookiesLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "2025 NBA Rookie Class Index",
    url: `${SITE_URL}/insights/rookies`,
    description:
      "Per-player 30-day GMV, lock-rate, and first-mint trophy presence for the 2025 NBA rookie class on Top Shot. Refreshes hourly.",
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
