// app/insights/top-sales/layout.tsx
//
// SEO surface for the public Top Sales / Whale Watch board. Server component so
// the metadata export is honored (a "use client" page.tsx cannot export
// metadata directly). The canonical is param-stripped (always
// /insights/top-sales) so the ?collection= / ?window= / ?sort= filtered URLs
// don't index as duplicate content. Mirrors app/insights/trophies/layout.tsx.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root metadata template in lib/seo.ts appends " | Rip Packs City",
  // so baking the brand in here rendered it twice. (deep-audit D24)
  title: "Top Sales — The Whales of the Week",
  description:
    "The biggest recent sales across NBA Top Shot and NFL All Day — with who bought and who sold each one. The freshest board on Flow. Free. No signup.",
  keywords: [
    "NBA Top Shot biggest sales",
    "Top Shot whale watch",
    "Top Shot recent sales",
    "NFL All Day biggest sales",
    "Flow blockchain top sales",
    "Top Shot sales tracker",
    "who bought Top Shot moment",
  ].join(", "),
  alternates: {
    canonical: `${SITE_URL}/insights/top-sales`,
  },
  openGraph: {
    title: "Top Sales — The Whales of the Week",
    description:
      "The biggest recent sales across NBA Top Shot and NFL All Day — with who bought and who sold each one.",
    url: `${SITE_URL}/insights/top-sales`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/top-sales`,
        width: 1200,
        height: 630,
        alt: "Top Sales — The Whales of the Week — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Top Sales — The Whales of the Week",
    description:
      "The biggest recent sales across NBA Top Shot and NFL All Day — with who bought and who sold each one.",
    images: [`${SITE_URL}/api/og/insights/top-sales`],
    creator: "@RipPacksCity",
  },
}

export default function TopSalesLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("top-sales")
  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />
      {children}
    </>
  )
}
