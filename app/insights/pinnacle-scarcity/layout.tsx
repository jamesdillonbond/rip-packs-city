// app/insights/pinnacle-scarcity/layout.tsx

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "Disney Pinnacle Scarcity Board | Rip Packs City",
  description:
    "Pinnacle doesn't show you the supply story. We do. Editions ranked by how far below their variant family's average mint they sit. Chasers, low-mint Standards, premium variants. Free. No signup.",
  keywords: [
    "Disney Pinnacle scarcity",
    "Pinnacle low mint",
    "Pinnacle chasers",
    "Disney NFT scarcity",
    "Pinnacle variants",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/pinnacle-scarcity` },
  openGraph: {
    title: "Disney Pinnacle Scarcity Board",
    description:
      "Pinnacle editions ranked by how rare they actually are vs their variant family. The supply story Pinnacle's UI doesn't lead with.",
    url: `${SITE_URL}/insights/pinnacle-scarcity`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pinnacle-scarcity`,
        width: 1200,
        height: 630,
        alt: "Disney Pinnacle Scarcity Board — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Disney Pinnacle Scarcity Board",
    description:
      "Pinnacle editions ranked by scarcity vs their variant family.",
    images: [`${SITE_URL}/api/og/insights/pinnacle-scarcity`],
    creator: "@RipPacksCity",
  },
}

export default function PinnacleScarcityLayout({ children }: { children: React.ReactNode }) {
  return children
}
