// app/insights/allday-market/layout.tsx
//
// SEO surface for The RPC Index on NFL All Day (2026-10-28). Its own URL, title, canonical, JSON-LD and OG card —
// one collection, one URL (docs/reference/architecture-notes.md): a ?collection= toggle on /insights/market would
// share Top Shot's metadata with every crawler and unfurler. Mirrors app/insights/market/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"
const OG_IMAGE = `${SITE_URL}/api/og/insights/allday-market`

export const metadata: Metadata = {
  // The root metadata template appends " | Rip Packs City".
  title: "The RPC Index — Tier-Segmented NFL All Day Market",
  description:
    "NFL All Day's blended price is dominated by commons. The RPC Index segments the market by tier and normalizes each to 100 — a free, honest read of Legendary, Rare, Uncommon, and Common momentum. No signup.",
  keywords: [
    "NFL All Day market index",
    "NFL All Day price index",
    "NFL All Day market trend",
    "NFL All Day tier prices",
    "NFL All Day legendary price",
    "NFL All Day volume",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/allday-market`,
  },
  openGraph: {
    title: "The RPC Index — Tier-Segmented NFL All Day Market",
    description:
      "One blended price hides everything. The RPC Index segments NFL All Day by tier and indexes each to 100 — honest market momentum.",
    url: `${SITE_URL}/insights/allday-market`,
    siteName: "Rip Packs City",
    images: [
      {
        url: OG_IMAGE,
        width: 1200,
        height: 630,
        alt: "The RPC Index — Tier-Segmented NFL All Day Market — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "The RPC Index — Tier-Segmented NFL All Day Market",
    description:
      "One blended price hides everything. The RPC Index segments NFL All Day by tier and indexes each to 100.",
    images: [OG_IMAGE],
    creator: "@RipPacksCity",
  },
}

export default function AllDayMarketIndexLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("allday-market")
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
