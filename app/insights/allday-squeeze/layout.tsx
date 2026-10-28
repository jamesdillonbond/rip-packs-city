// app/insights/allday-squeeze/layout.tsx
//
// SEO surface for NFL All Day's lock-rate squeeze board (2026-10-27). The board
// itself is the shared SqueezeBoardClient; before this page, All Day's leg lived
// only behind the /insights/squeeze?collection=nfl-all-day toggle, whose metadata
// is Top Shot's — an All Day share previewed Top Shot's title and top three, and
// no crawler ever saw an All Day row. This page gives All Day its own URL, title,
// canonical, OG card and server-rendered rows.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const OG_IMAGE = `${SITE_URL}/api/og/insights/allday-squeeze`

export const metadata: Metadata = {
  title: "NFL All Day Lock-Rate Squeeze Board",
  description:
    "NFL All Day displays circulation. We display effective supply. The lock-rate squeeze board ranks NFL All Day editions by how locked + burned their circulation actually is. Free. No signup.",
  keywords: [
    "NFL All Day squeeze",
    "NFL All Day lock rate",
    "NFL All Day effective supply",
    "NFL All Day burned moments",
    "NFL All Day moments locked",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/allday-squeeze`,
  },
  openGraph: {
    title: "NFL All Day Lock-Rate Squeeze Board",
    description:
      "NFL All Day shows circulation. We show effective supply — the moments actually purchasable after locks + burns.",
    url: `${SITE_URL}/insights/allday-squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "NFL All Day Lock-Rate Squeeze Board — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "NFL All Day Lock-Rate Squeeze Board",
    description:
      "NFL All Day shows circulation. We show effective supply — the moments actually purchasable after locks + burns.",
    images: [OG_IMAGE],
    creator: "@RipPacksCity",
  },
}

export default function AllDaySqueezeLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("allday-squeeze")
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
