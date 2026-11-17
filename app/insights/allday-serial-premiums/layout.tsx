// app/insights/allday-serial-premiums/layout.tsx
//
// SEO surface for NFL All Day Serial Premiums (2026-10-28). Its own URL, title, canonical, JSON-LD and OG card —
// one collection, one URL (docs/reference/architecture-notes.md). Mirrors app/insights/serial-premiums/layout.tsx.
// The canonical is param-stripped, so ?headline=perfect does not index as a duplicate.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const OG_IMAGE = `${SITE_URL}/api/og/insights/allday-serial-premiums`

export const metadata: Metadata = {
  title: "NFL All Day Serial Premiums — What the #1 Mint Really Sells For",
  description:
    "What NFL All Day collectors actually paid for the #1 mint and the perfect mint versus the edition's typical price. Every row a real on-chain sale, ranked by premium. Free. No signup.",
  keywords: [
    "NFL All Day serial premium",
    "NFL All Day #1 serial",
    "NFL All Day perfect mint",
    "NFL All Day serial 1 price",
    "NFL All Day low serial",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/allday-serial-premiums`,
  },
  openGraph: {
    title: "NFL All Day Serial Premiums — What the #1 Mint Really Sells For",
    description:
      "What NFL All Day collectors actually paid for the #1 and perfect mint versus the edition's typical price — real sales, ranked by premium.",
    url: `${SITE_URL}/insights/allday-serial-premiums`,
    siteName: "Rip Packs City",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "NFL All Day Serial Premiums — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "NFL All Day Serial Premiums — What the #1 Mint Really Sells For",
    description: "What NFL All Day collectors actually paid for the #1 and perfect mint versus the edition's typical price.",
    images: [OG_IMAGE],
    creator: "@RipPacksCity",
  },
}

export default function AllDaySerialPremiumsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("allday-serial-premiums")
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
