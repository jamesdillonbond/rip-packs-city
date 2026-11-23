// app/insights/pinnacle-serial-premiums/layout.tsx
//
// SEO surface for the public Disney Pinnacle Serial Premiums board (2026-11-23). The OG card is the registry-driven default
// (app/api/og/insights/[slug]) — text only, no number that could go stale.

import type { Metadata } from "next"
import { TWITTER_INHERITED, insightsBoardJsonLd } from "@/lib/seo"
import { jsonLdScript } from "@/lib/seo/json-ld-script"

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

export const metadata: Metadata = {
  // The root template appends " | Rip Packs City" (deep-audit D24).
  title: "Disney Pinnacle Serial Premiums",
  description:
    "What #1 and perfect-serial Disney Pinnacle pins actually sell for vs the same pin's other serials — every sale on record, with the premium. Free. No signup.",
  keywords: [
    "Disney Pinnacle serial number value",
    "Pinnacle #1 serial",
    "Disney Pinnacle perfect serial",
    "Pinnacle serial premium",
  ].join(", "),
  alternates: { canonical: `${SITE_URL}/insights/pinnacle-serial-premiums` },
  openGraph: {
    title: "Disney Pinnacle Serial Premiums",
    description: "#1 and perfect serials vs the rest of the run — the real Disney Pinnacle serial premium.",
    url: `${SITE_URL}/insights/pinnacle-serial-premiums`,
    siteName: "Rip Packs City",
    images: [
      {
        url: `${SITE_URL}/api/og/insights/pinnacle-serial-premiums`,
        width: 1200,
        height: 630,
        alt: "Disney Pinnacle Serial Premiums — Rip Packs City",
      },
    ],
    locale: "en_US",
    type: "website",
  },
  twitter: {
    ...TWITTER_INHERITED,
    card: "summary_large_image",
    title: "Disney Pinnacle Serial Premiums",
    description: "#1 and perfect serials vs the rest of the run — the real Disney Pinnacle serial premium.",
    images: [`${SITE_URL}/api/og/insights/pinnacle-serial-premiums`],
    creator: "@RipPacksCity",
  },
}

export default function PinnacleSerialPremiumsLayout({ children }: { children: React.ReactNode }) {
  const jsonLd = insightsBoardJsonLd("pinnacle-serial-premiums")
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }} />
      {children}
    </>
  )
}
