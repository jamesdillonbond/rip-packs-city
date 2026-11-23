// app/insights/pinnacle-pack-reality/layout.tsx
//
// SEO surface for the public Disney Pinnacle Pack Reality board (2026-11-23). The OG card is the
// registry-driven default (app/api/og/insights/[slug]) — text only, no number that could go stale.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root template appends " | Rip Packs City" (deep-audit D24).
  title: "Disney Pinnacle Pack Reality",
  description:
    "Did Disney Pinnacle packs pay? Every drop since September 2026: the retail price vs what its opened packs' pins were worth when opened and are worth today, from every on-chain open. Free. No signup.",
  keywords: [
    "Disney Pinnacle packs",
    "Disney Pinnacle pack value",
    "Disney Pinnacle pack EV",
    "Pinnacle pack worth it",
    "Disney Pinnacle drops",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/pinnacle-pack-reality` },
  openGraph: {
    title: "Disney Pinnacle Pack Reality",
    description: "Retail price vs what Disney Pinnacle packs actually pulled — at open and today — for every drop since September.",
    url: `${SITE_URL}/insights/pinnacle-pack-reality`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pinnacle-pack-reality`,
        width: 1200,
        height: 630,
        alt: "Disney Pinnacle Pack Reality — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Disney Pinnacle Pack Reality",
    description: "Did Disney Pinnacle packs pay? Price vs pulls, at open and today.",
    images: [`${SITE_URL}/api/og/insights/pinnacle-pack-reality`],
    creator: "@RipPacksCity",
  },
}

export default function PinnaclePackRealityLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("pinnacle-pack-reality")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
