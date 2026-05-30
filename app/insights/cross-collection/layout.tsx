// app/insights/cross-collection/layout.tsx

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Cross-Collection Whale Map | Rip Packs City",
  description:
    "143 wallets hold 3+ Flow blockchain collections — Top Shot, AllDay, Golazos, Pinnacle, UFC Strike. Cohort distribution, top wallets, TS set overlap. Free. No signup.",
  keywords: [
    "Flow blockchain whales",
    "NBA Top Shot whales",
    "NFL All Day whales",
    "cross-collection collectors",
    "Flow NFT cohort",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/cross-collection` },
  openGraph: {
    title: "Cross-Collection Whale Map",
    description:
      "143 wallets hold 3+ Flow collections. Their cohort distribution + the TS sets they actually collect.",
    url: `${SITE_URL}/insights/cross-collection`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/cross-collection`,
        width: 1200,
        height: 630,
        alt: "Cross-Collection Whale Map — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Cross-Collection Whale Map",
    description: "143 wallets hold 3+ Flow collections — their cohort, broken down.",
    images: [`${SITE_URL}/api/og/insights/cross-collection`],
    creator: "@RipPacksCity",
  },
}

export default function CrossCollectionLayout({ children }: { children: React.ReactNode }) {
  return children
}
