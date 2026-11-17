// app/insights/new-collectors/layout.tsx
//
// SEO surface for the public New Collectors board. Server component so the
// metadata export is honored (a "use client" page.tsx cannot export metadata
// directly). The canonical is param-stripped (always /insights/new-collectors)
// so any ?window= filtered URL doesn't index as duplicate content. Mirrors
// app/insights/serial-premiums/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "New Collectors — Who's Entering Top Shot, and What They Buy First",
  description:
    "NBA Top Shot's acquisition funnel: new vs returning buyers, first-buy price, the sets and players new collectors pick first, and monthly cohort retention & LTV. Free. No signup.",
  keywords: [
    "NBA Top Shot new collectors",
    "Top Shot new buyers",
    "Top Shot acquisition funnel",
    "Top Shot cohort retention",
    "Top Shot first buy price",
    "Top Shot gateway moments",
    "Flow blockchain collector growth",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/new-collectors`,
  },
  openGraph: {
    title: "New Collectors — Who's Entering Top Shot, and What They Buy First",
    description:
      "New vs returning buyers, first-buy price, the gateway sets and players new collectors pick first, and monthly cohort retention & LTV on NBA Top Shot.",
    url: `${SITE_URL}/insights/new-collectors`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/new-collectors`,
        width: 1200,
        height: 630,
        alt: "New Collectors — Who's Entering Top Shot — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "New Collectors — Who's Entering Top Shot, and What They Buy First",
    description:
      "NBA Top Shot's acquisition funnel + cohort retention, from buyer-resolved on-chain sales.",
    images: [`${SITE_URL}/api/og/insights/new-collectors`],
    creator: "@RipPacksCity",
  },
}

export default function NewCollectorsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("new-collectors")
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
