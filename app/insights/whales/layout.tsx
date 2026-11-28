// app/insights/whales/layout.tsx
//
// SEO surface for the public Whale Watch board. Server component so the metadata
// export is honored. The canonical is param-stripped (always /insights/whales) so a
// ?window= URL never indexes as a duplicate. Mirrors app/insights/new-collectors/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"
import { OG_CARD_VERSION } from "@/lib/og/card-day-key"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const TITLE = "Whale Watch — Who's Spending Big on Top Shot, Panini, All Day and More"
const DESCRIPTION =
  "The collectors behind the biggest sales on NBA Top Shot, NFL All Day, Panini, Candy MLB, Disney Pinnacle, LaLiga Golazos and UFC Strike — what they spent this week and this month, and their latest big buys. Free. No signup."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "NBA Top Shot whales",
    "Top Shot biggest buyers",
    "Panini blockchain whales",
    "NFL All Day big buyers",
    "digital collectibles whale watch",
    "Top Shot top spenders",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/whales` },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/insights/whales`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/whales?v=${OG_CARD_VERSION}`,
        width: 1200,
        height: 630,
        alt: "Whale Watch — Who's Spending Big — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: TITLE,
    description: "Who's spending big across every collection we track — this week, this month, and their latest buys.",
    images: [`${SITE_URL}/api/og/insights/whales?v=${OG_CARD_VERSION}`],
    creator: "@RipPacksCity",
  },
}

export default function WhalesLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("whales")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
