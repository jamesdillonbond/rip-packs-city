// app/insights/pinnacle-squeeze/layout.tsx
//
// SEO surface for the public Disney Pinnacle Squeeze Board (2026-11-23). The OG card is the registry-driven default
// (app/api/og/insights/[slug]) — text only, no number that could go stale.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"
import { OG_CARD_VERSION } from "@/lib/og/card-day-key"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root template appends " | Rip Packs City" (deep-audit D24).
  title: "Disney Pinnacle Squeeze Board",
  description:
    "Disney Pinnacle pins ranked by how few collector-held copies are listed for sale — the tightest supply first, from a complete sweep of the marketplace. Free. No signup.",
  keywords: [
    "Disney Pinnacle supply",
    "Pinnacle listings",
    "Disney Pinnacle rare pins",
    "Pinnacle squeeze",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/pinnacle-squeeze` },
  openGraph: {
    title: "Disney Pinnacle Squeeze Board",
    description: "Which Disney Pinnacle pins are collectors not selling? Listed share of collector-held supply.",
    url: `${SITE_URL}/insights/pinnacle-squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pinnacle-squeeze?v=${OG_CARD_VERSION}`,
        width: 1200,
        height: 630,
        alt: "Disney Pinnacle Squeeze Board — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Disney Pinnacle Squeeze Board",
    description: "Which Disney Pinnacle pins are collectors not selling? Listed share of collector-held supply.",
    images: [`${SITE_URL}/api/og/insights/pinnacle-squeeze?v=${OG_CARD_VERSION}`],
    creator: "@RipPacksCity",
  },
}

export default function PinnacleSqueezeLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("pinnacle-squeeze")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
