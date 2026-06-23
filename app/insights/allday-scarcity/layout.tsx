// app/insights/allday-scarcity/layout.tsx

import type { Metadata } from "next"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  title: "NFL All Day Scarcity Board | Rip Packs City",
  description:
    "All Day doesn't show you the supply story. We do. Editions ranked by how far below their set + tier family's average mint they sit. Low-mint parallels, #1 mints, premium tiers. Free. No signup.",
  keywords: [
    "NFL All Day scarcity",
    "All Day low mint",
    "NFL All Day rare moments",
    "All Day parallels",
    "NFL All Day mint count",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/allday-scarcity` },
  openGraph: {
    title: "NFL All Day Scarcity Board",
    description:
      "All Day editions ranked by how rare they actually are vs their set + tier family. The supply story All Day's UI doesn't lead with.",
    url: `${SITE_URL}/insights/allday-scarcity`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/allday-scarcity`,
        width: 1200,
        height: 630,
        alt: "NFL All Day Scarcity Board — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NFL All Day Scarcity Board",
    description:
      "All Day editions ranked by scarcity vs their set + tier family.",
    images: [`${SITE_URL}/api/og/insights/allday-scarcity`],
    creator: "@RipPacksCity",
  },
}

export default function AllDayScarcityLayout({ children }: { children: React.ReactNode }) {
  return children
}
