// app/insights/candy-squeeze/layout.tsx
//
// SEO surface for the public Candy Squeeze Board (2026-11-23, Candy parity pass 1). The OG card is the registry-driven
// default (app/api/og/insights/[slug]) — text only, no number that could go stale.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"
import { OG_CARD_VERSION } from "@/lib/og/card-day-key"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root template appends " | Rip Packs City" (deep-audit D24).
  title: "Candy Squeeze Board",
  description:
    "Candy cards ranked by how few collector-held copies are listed for sale on Magic Eden or OpenSea — the 2026 MLB ICONs and every older Candy set, tightest supply first. Free. No signup.",
  keywords: [
    "Candy MLB ICON supply",
    "Candy Digital listings",
    "Candy All-Star Game ICONs",
    "Candy squeeze",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/candy-squeeze` },
  openGraph: {
    title: "Candy Squeeze Board",
    description: "Which Candy ICONs are collectors not selling? Listed share of collector-held supply.",
    url: `${SITE_URL}/insights/candy-squeeze`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/candy-squeeze?v=${OG_CARD_VERSION}`,
        width: 1200,
        height: 630,
        alt: "Candy Squeeze Board — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Candy Squeeze Board",
    description: "Which Candy ICONs are collectors not selling? Listed share of collector-held supply.",
    images: [`${SITE_URL}/api/og/insights/candy-squeeze?v=${OG_CARD_VERSION}`],
    creator: "@RipPacksCity",
  },
}

export default function CandySqueezeLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("candy-squeeze")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
