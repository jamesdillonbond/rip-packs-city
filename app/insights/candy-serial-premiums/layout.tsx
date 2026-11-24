// app/insights/candy-serial-premiums/layout.tsx
//
// SEO surface for the public Candy Serial Premiums board (2026-11-23, Candy parity pass 1). The OG card is the registry-driven default
// (app/api/og/insights/[slug]) — text only, no number that could go stale.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root template appends " | Rip Packs City" (deep-audit D24).
  title: "Candy Serial Premiums",
  description:
    "What #1, jersey-match and perfect-serial Candy ICONs actually sell for vs the same card's other serials — every sale on record, with the premium. Free. No signup.",
  keywords: [
    "Candy ICON serial number value",
    "Candy MLB #1 serial",
    "Candy jersey number serial",
    "Candy serial premium",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/candy-serial-premiums` },
  openGraph: {
    title: "Candy Serial Premiums",
    description: "#1, jersey and perfect serials vs the rest of the run — the real Candy serial premium.",
    url: `${SITE_URL}/insights/candy-serial-premiums`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/candy-serial-premiums`,
        width: 1200,
        height: 630,
        alt: "Candy Serial Premiums — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Candy Serial Premiums",
    description: "#1, jersey and perfect serials vs the rest of the run — the real Candy serial premium.",
    images: [`${SITE_URL}/api/og/insights/candy-serial-premiums`],
    creator: "@RipPacksCity",
  },
}

export default function CandySerialPremiumsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("candy-serial-premiums")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
