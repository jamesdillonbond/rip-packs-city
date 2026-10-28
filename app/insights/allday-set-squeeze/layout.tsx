// app/insights/allday-set-squeeze/layout.tsx
//
// SEO surface for NFL All Day's set squeeze leaderboard (2026-10-27). The board is
// the shared SetSqueezeBoardClient; before this page All Day's leg lived only behind
// /insights/set-squeeze?collection=nfl-all-day, whose metadata and OG card are Top
// Shot's (an All Day share previewed Top Shot's sets). Own URL, title, canonical,
// OG card and server-rendered rows.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const OG_IMAGE = `${SITE_URL}/api/og/insights/allday-set-squeeze`

export const metadata: Metadata = {
  title: "NFL All Day Set Squeeze Leaderboard",
  description:
    "NFL All Day sets ranked by average lock + burn squeeze across their editions. Drill-down companion to the All Day squeeze board. Set completionists' tightest targets. Free. No signup.",
  keywords: [
    "NFL All Day set squeeze",
    "NFL All Day set completion",
    "NFL All Day sets",
    "set scarcity",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/allday-set-squeeze` },
  openGraph: {
    title: "NFL All Day Set Squeeze Leaderboard",
    description:
      "NFL All Day sets ranked by average lock + burn across their editions. Set-completionist scarcity view.",
    url: `${SITE_URL}/insights/allday-set-squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "NFL All Day Set Squeeze Leaderboard — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "NFL All Day Set Squeeze Leaderboard",
    description: "NFL All Day sets ranked by lock + burn across editions.",
    images: [OG_IMAGE],
    creator: "@RipPacksCity",
  },
}

export default function AllDaySetSqueezeLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("allday-set-squeeze")
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
