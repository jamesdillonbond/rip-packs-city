// app/insights/trade-in/layout.tsx
//
// SEO surface for the public Top Shot This trade-in finder. Canonical is
// param-stripped so ?player= / ?wallet= URLs don't index as duplicates. Mirrors
// autographs/layout.tsx. No counts or freshness claims in the copy.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

const TITLE = "Top Shot This Trade-In Finder — Cheapest Path to a Pack"
const DESCRIPTION =
  "Top Shot's Series 2026-27 trade-in counts every $10 of a player's Moments at Top Shot's own average sale price as one Top Shot This pack. See which editions count for the most versus what they cost to buy, and what your own Moments add up to. Free, no signup."

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  keywords: [
    "Top Shot This trade-in",
    "NBA Top Shot trade in",
    "Top Shot This pack",
    "Top Shot average sale price",
    "Top Shot trade-in calculator",
    "Series 2026-27 trade in",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/trade-in` },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: `${SITE_URL}/insights/trade-in`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/trade-in`,
        width: 1200,
        height: 630,
        alt: `${TITLE} — Rip Packs City`,
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: TITLE,
    description: "Which Top Shot Moments count for the most in a Top Shot This trade-in versus what they cost — and what your own Moments add up to.",
    images: [`${SITE_URL}/api/og/insights/trade-in`],
    creator: "@RipPacksCity",
  },
}

export default function TradeInLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("trade-in")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
