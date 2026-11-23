// app/insights/pinnacle-market/layout.tsx
//
// SEO surface for The RPC Index on Disney Pinnacle (2026-11-23). Its own URL, title, canonical, JSON-LD and OG card —
// one collection, one URL (docs/reference/architecture-notes.md): a ?collection= toggle on /insights/market would
// share Top Shot's metadata with every crawler and unfurler. Mirrors app/insights/market/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const OG_IMAGE = `${SITE_URL}/api/og/insights/pinnacle-market`

export const metadata: Metadata = {
  // The root metadata template appends " | Rip Packs City".
  title: "The RPC Index — Edition-Type Disney Pinnacle Market",
  description:
    "Disney Pinnacle's blended price is dominated by Open Edition pins. The RPC Index segments the market by edition type and normalizes each to 100 — a free, honest read of Limited and Open pin momentum. No signup.",
  keywords: [
    "Disney Pinnacle market index",
    "Disney Pinnacle price index",
    "Disney Pinnacle market trend",
    "Disney Pinnacle pin prices",
    "Disney Pinnacle limited edition price",
    "Disney Pinnacle volume",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/pinnacle-market`,
  },
  openGraph: {
    title: "The RPC Index — Edition-Type Disney Pinnacle Market",
    description:
      "One blended price hides everything. The RPC Index segments Disney Pinnacle by edition type and indexes each to 100 — honest market momentum.",
    url: `${SITE_URL}/insights/pinnacle-market`,
    siteName: "Rip Packs City",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "The RPC Index — Edition-Type Disney Pinnacle Market — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "The RPC Index — Edition-Type Disney Pinnacle Market",
    description:
      "One blended price hides everything. The RPC Index segments Disney Pinnacle by edition type and indexes each to 100.",
    images: [OG_IMAGE],
    creator: "@RipPacksCity",
  },
}

export default function PinnacleMarketIndexLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("pinnacle-market")
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
