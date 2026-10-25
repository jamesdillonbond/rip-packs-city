// app/insights/rookies/layout.tsx
//
// SEO surface for the public NBA Rookie Class Index (2025 + 2026 classes since 2026-10-22).

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "NBA Rookie Class Index — 2025 & 2026",
  description:
    "The 2025 and 2026 NBA rookie classes on Top Shot — 30-day GMV, lock rates, average prices, first-mint trophy multipliers. Cooper Flagg, Dylan Harper, Kon Knueppel, Darryn Peterson, Cameron Boozer. Free. No signup.",
  keywords: [
    "NBA Top Shot rookies",
    "2025 NBA Draft Top Shot",
    "2026 NBA rookies Top Shot",
    "Darryn Peterson Top Shot",
    "Cameron Boozer Top Shot",
    "Top Shot rookie ranking",
    "Cooper Flagg Top Shot",
    "Dylan Harper Top Shot",
    "Kon Knueppel Top Shot",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/rookies`,
  },
  openGraph: {
    title: "NBA Rookie Class Index — 2025 & 2026",
    description:
      "30-day GMV, lock rates, mint #1 trophy presence across the 2025 and 2026 NBA rookie classes on Top Shot.",
    url: `${SITE_URL}/insights/rookies`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/rookies`,
        width: 1200,
        height: 630,
        alt: "NBA Rookie Class Index — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "NBA Rookie Class Index — 2025 & 2026",
    description:
      "The 2025 and 2026 NBA rookie classes on Top Shot. GMV, lock rates, first-mint trophies.",
    images: [`${SITE_URL}/api/og/insights/rookies`],
    creator: "@RipPacksCity",
  },
}

export default function RookiesLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("rookies")
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      />
      {children}
    </>
  )
}
